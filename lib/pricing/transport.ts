/**
 * Transport pricing — THE single engine.
 *
 * Every surface that prices transport calls priceTransport() in this file:
 * the Quote Builder, the rep quote route, hold requests, and the internal
 * MCP endpoint. There is no second implementation and no inline copy of
 * these rules anywhere else. If transport pricing changes, it changes here.
 *
 * ---------------------------------------------------------------------------
 * Policy (one rule set, all callers)
 * ---------------------------------------------------------------------------
 *
 *   Swarm gate   More trucks than the market's base concurrency exits auto-
 *                pricing entirely and returns MANUAL_QUOTE.
 *
 *   Who is billed  Only trucks that must actually reposition — further than
 *                  the service area radius (default 250mi) from the campaign.
 *                  A truck already in market is never charged.
 *
 *   Absorbed when  The client's rate agreement sets transport_included, OR
 *                  the campaign is 10+ activation days AND booked with 10+
 *                  business days of lead time. Both conditions, not either.
 *
 *   How much       Per repositioning truck, from its own actual distance:
 *                    (transport days x day rate) + airfare home
 *                    + (overnights x hotel per diem)
 *                  Transport days = ceil(distance / 450), minimum 1.
 *
 * Callers differ only in how they supply legs, not in the rules applied:
 *   - Quote/hold routes pass real trucks with live GPS distances.
 *   - The MCP endpoint has no truck selection, so it estimates every truck
 *     as sitting at the nearest accepted market (see estimatedLegs).
 *
 * When transport is absorbed or no truck needs repositioning, the buyer sees
 * no transport line at all — not a $0 line (spec §7).
 *
 * Source: Transport Pricing Implementation Spec v1, 30 July 2026, unified
 * onto the per-truck model 2026-09-11.
 */

import { TRANSPORT_CONFIG, SERVICE_AREA_RADIUS_MILES } from './config'

// ---------------------------------------------------------------------------
// Absorption thresholds
// ---------------------------------------------------------------------------

export const MIN_ACTIVATION_DAYS_TO_ABSORB = 10
export const MIN_LEAD_BUSINESS_DAYS_TO_ABSORB = 10

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** Per-client transport cost overrides, from a Rate Agreement. */
export type TransportCostOverrides = {
  dayRate?: number
  airfare?: number
  hotelPerNight?: number
}

/** One truck's position relative to the campaign. */
export type TruckLeg = {
  distanceMiles: number
  needsRepositioning: boolean
  truckNumber?: string
  fromMarket?: string
}

export type TransportOrder = {
  /** Billable activation days — NOT the calendar span. */
  activationDays: number
  /** Business days between today and campaign start. */
  leadBusinessDays: number
  /** One leg per truck assigned to the campaign. */
  legs: TruckLeg[]
  /** Nearest market's concurrent truck capacity. null skips the swarm gate. */
  baseConcurrency: number | null
  /** Rate agreement: always absorb transport for this client. */
  transportIncluded?: boolean
  overrides?: TransportCostOverrides | null
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type PricedLeg = {
  distanceMiles: number
  transportDays: number
  charge: number
  truckNumber?: string
  fromMarket?: string
}

export type TransportOutcome = 'INCLUDED' | 'ABSORBED' | 'BILLED' | 'MANUAL_QUOTE'

export type TransportResult = {
  outcome: TransportOutcome
  /** Only set on MANUAL_QUOTE. */
  reason?: 'SWARM'
  /** Total charged across all repositioning trucks. 0 unless BILLED. */
  charge: number
  absorbed: boolean
  absorbedReason?: string
  repositioningTruckCount: number
  localTruckCount: number
  /** Repositioning legs only; charge is 0 on each when absorbed. */
  legs: PricedLeg[]
  depositRequired: boolean
  depositPerTruck: number
  depositAmount: number
}

// ---------------------------------------------------------------------------
// Derived cost helpers (compute, do not hardcode — per spec §2)
// ---------------------------------------------------------------------------

export function fuelPerTransportDay(): number {
  const { milesPerDay, mpg, dieselPerGal } = TRANSPORT_CONFIG.transportDay
  return milesPerDay / mpg * dieselPerGal
}

export function transportDayCost(): number {
  const { driver, repairs } = TRANSPORT_CONFIG.transportDay
  return fuelPerTransportDay() + driver + repairs
}

export function activationDayCost(): number {
  const ad = TRANSPORT_CONFIG.activationDay
  return ad.driver + ad.fuel + ad.insurance + ad.repairs + ad.tech
}

export function absorbedLegCost(transportDays: number): number {
  return (
    transportDays * transportDayCost()
    + Math.max(transportDays - 1, 0) * TRANSPORT_CONFIG.hotelPerDiemPerNight
    + TRANSPORT_CONFIG.airfareHomeOneWay
    + TRANSPORT_CONFIG.tollsPerLeg
  )
}

/**
 * Transport days for a distance. Each day covers 450 miles.
 * Note this is the driving range per day — NOT the service area radius.
 */
export function transportDaysFromDistance(distanceMiles: number): number {
  return Math.max(1, Math.ceil(distanceMiles / TRANSPORT_CONFIG.transportDay.milesPerDay))
}

/**
 * Whether a truck at this distance has to reposition to serve the campaign.
 * The single definition of the service-area boundary.
 */
export function needsRepositioning(distanceMiles: number, serviceAreaMiles?: number): boolean {
  return distanceMiles > (serviceAreaMiles ?? SERVICE_AREA_RADIUS_MILES)
}

/**
 * Billed cost of repositioning ONE truck across a given distance.
 * The only place this formula exists.
 */
export function chargeForLeg(
  distanceMiles: number,
  overrides?: TransportCostOverrides | null,
): number {
  const days = transportDaysFromDistance(distanceMiles)
  const overnights = Math.max(days - 1, 0)
  return (
    days * (overrides?.dayRate ?? TRANSPORT_CONFIG.exceptionTransportDayRate)
    + (overrides?.airfare ?? TRANSPORT_CONFIG.airfareHomeOneWay)
    + overnights * (overrides?.hotelPerNight ?? TRANSPORT_CONFIG.hotelPerDiemPerNight)
  )
}

/**
 * Build legs for callers that have no truck selection (the MCP endpoint).
 *
 * Every truck is assumed to be sitting at the nearest accepted market, so the
 * campaign's distance to that market stands in for each truck's real distance.
 * This is an estimate: once trucks are actually selected, the quote routes
 * price the same order from live GPS positions and may land lower.
 */
export function estimatedLegs(
  truckCount: number,
  distanceToNearestMarketMiles: number,
  serviceAreaMiles?: number,
): TruckLeg[] {
  const repositions = needsRepositioning(distanceToNearestMarketMiles, serviceAreaMiles)
  return Array.from({ length: truckCount }, () => ({
    distanceMiles: distanceToNearestMarketMiles,
    needsRepositioning: repositions,
  }))
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export function priceTransport(order: TransportOrder): TransportResult {
  const { activationDays, leadBusinessDays, legs, baseConcurrency, overrides } = order

  const empty = {
    charge: 0,
    absorbed: false,
    repositioningTruckCount: 0,
    localTruckCount: 0,
    legs: [] as PricedLeg[],
    depositRequired: false,
    depositPerTruck: 0,
    depositAmount: 0,
  }

  // Swarm gate: more trucks than the market can field exits auto-pricing.
  if (baseConcurrency !== null && legs.length > baseConcurrency) {
    return { ...empty, outcome: 'MANUAL_QUOTE', reason: 'SWARM' }
  }

  const repoLegs = legs.filter(l => l.needsRepositioning)
  const localCount = legs.length - repoLegs.length

  // Nothing to reposition — no transport line at all.
  if (repoLegs.length === 0) {
    return { ...empty, outcome: 'INCLUDED', localTruckCount: localCount }
  }

  const absorbed =
    order.transportIncluded === true
    || (activationDays >= MIN_ACTIVATION_DAYS_TO_ABSORB
        && leadBusinessDays >= MIN_LEAD_BUSINESS_DAYS_TO_ABSORB)

  const pricedLegs: PricedLeg[] = repoLegs.map(l => ({
    distanceMiles: l.distanceMiles,
    transportDays: transportDaysFromDistance(l.distanceMiles),
    charge: absorbed ? 0 : chargeForLeg(l.distanceMiles, overrides),
    truckNumber: l.truckNumber,
    fromMarket: l.fromMarket,
  }))

  const charge = pricedLegs.reduce((sum, l) => sum + l.charge, 0)

  if (absorbed) {
    return {
      ...empty,
      outcome: 'ABSORBED',
      absorbed: true,
      absorbedReason: `Transport included for campaigns of ${MIN_ACTIVATION_DAYS_TO_ABSORB}+ days with ${MIN_LEAD_BUSINESS_DAYS_TO_ABSORB}+ business days notice.`,
      repositioningTruckCount: repoLegs.length,
      localTruckCount: localCount,
      legs: pricedLegs,
    }
  }

  const depositPerTruck =
    TRANSPORT_CONFIG.depositTransportDays
    * (overrides?.dayRate ?? TRANSPORT_CONFIG.exceptionTransportDayRate)

  return {
    outcome: 'BILLED',
    charge,
    absorbed: false,
    repositioningTruckCount: repoLegs.length,
    localTruckCount: localCount,
    legs: pricedLegs,
    depositRequired: true,
    depositPerTruck,
    depositAmount: depositPerTruck * repoLegs.length,
  }
}

// ---------------------------------------------------------------------------
// Cancellation charge (spec §5)
// ---------------------------------------------------------------------------

export function cancellationCharge(
  distanceToNearestMarketMiles: number,
  truckCount: number,
  dispatched: boolean,
  overrides?: TransportCostOverrides | null,
): number {
  if (!dispatched) return 0
  return chargeForLeg(distanceToNearestMarketMiles, overrides) * truckCount
}

// ---------------------------------------------------------------------------
// Internal margin check (spec §6) — NEVER surfaced to a buyer
// ---------------------------------------------------------------------------

export type MarginCheck = {
  revenue: number
  directCost: number
  absorbedTransport: number
  grossContribution: number
  grossContributionPct: number
  flagForReview: boolean
}

export function marginCheck(
  flightDays: number,
  actualDailyRate: number,
  transportBilled: boolean,
  distanceToNearestMarketMiles: number,
): MarginCheck {
  const revenue = flightDays * actualDailyRate
  const directCost = flightDays * activationDayCost()
  const transportDays = transportDaysFromDistance(distanceToNearestMarketMiles)
  const absorbedTransportCost = transportBilled ? 0 : absorbedLegCost(transportDays)

  const grossContribution = revenue - directCost - absorbedTransportCost
  const grossContributionPct = revenue > 0 ? grossContribution / revenue : 0

  return {
    revenue,
    directCost,
    absorbedTransport: absorbedTransportCost,
    grossContribution,
    grossContributionPct,
    flagForReview: grossContributionPct < TRANSPORT_CONFIG.baseCaseGcPct,
  }
}

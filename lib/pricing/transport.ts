/**
 * Transport pricing layer.
 *
 * Inclusion zone model: accepted markets define operational bases. The 450-mile
 * radius (SERVICE_AREA_RADIUS_MILES) is the inclusion zone boundary.
 *
 * Four triggers can cause transport to be billed:
 *   1. SHORT_FLIGHT — campaign under 3 days
 *   2. RUSH — lead time under 10 business days
 *   3. OUTSIDE_INCLUSION_ZONE — campaign city > 450 miles from nearest accepted market
 *   4. SWARM — more trucks than market base concurrency (→ manual quote, exits pricing)
 *
 * When inside the inclusion zone and no other trigger fires, transport is absorbed
 * into the day rate — the buyer sees no transport line at all.
 *
 * Rules do not stack: one transport charge regardless of how many triggers fire.
 * Transport days are derived from actual distance: ceil(distance / 450).
 *
 * Source: Transport Pricing Implementation Spec v1, 30 July 2026.
 */

import { TRANSPORT_CONFIG, SERVICE_AREA_RADIUS_MILES } from './config'

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type TransportOrder = {
  flightDays: number          // billable campaign days
  leadBusinessDays: number    // confirmation date -> first activation day
  simultaneousUnits: number   // trucks requested concurrently
  // Market location — resolved by the quote endpoint from geocoding
  distanceToNearestMarketMiles: number
  nearestMarketDma: string
  nearestMarketBaseConcurrency: number
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type TransportIncluded = {
  outcome: 'INCLUDED'
  transportCharge: 0
}

export type TransportBilled = {
  outcome: 'BILLED'
  triggers: TransportTrigger[]
  transportDays: number
  chargePerTruck: number
  transportCharge: number    // chargePerTruck * simultaneousUnits
  truckCount: number
  depositRequired: boolean
  depositPerTruck: number
  depositAmount: number      // depositPerTruck * simultaneousUnits
}

export type TransportManualQuote = {
  outcome: 'MANUAL_QUOTE'
  reason: 'SWARM'
}

export type TransportTrigger = 'SHORT_FLIGHT' | 'RUSH' | 'OUTSIDE_INCLUSION_ZONE'

export type TransportResult =
  | TransportIncluded
  | TransportBilled
  | TransportManualQuote

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
 * Compute transport days from distance.
 * Each transport day covers 450 miles (TRANSPORT_CONFIG.transportDay.milesPerDay).
 */
export function transportDaysFromDistance(distanceMiles: number): number {
  return Math.max(1, Math.ceil(distanceMiles / TRANSPORT_CONFIG.transportDay.milesPerDay))
}

// ---------------------------------------------------------------------------
// Transport pricing algorithm (spec §4, adapted for inclusion zone model)
//
// Evaluate in order. Charge is computed once — rules do not stack.
// ---------------------------------------------------------------------------

export function priceTransport(order: TransportOrder): TransportResult {
  // R4 first: swarm exits auto-pricing entirely
  if (order.simultaneousUnits > order.nearestMarketBaseConcurrency) {
    return { outcome: 'MANUAL_QUOTE', reason: 'SWARM' }
  }

  // Evaluate all three transport triggers
  const isOutsideInclusionZone = order.distanceToNearestMarketMiles > SERVICE_AREA_RADIUS_MILES
  const isShortFlight = order.flightDays < TRANSPORT_CONFIG.minFlightDays
  const isRush = order.leadBusinessDays < TRANSPORT_CONFIG.standardLeadTimeBusinessDays

  const billed = isOutsideInclusionZone || isShortFlight || isRush

  if (!billed) {
    // Transport included — emit NO transport line (spec §7)
    return {
      outcome: 'INCLUDED',
      transportCharge: 0 as const,
    }
  }

  // Billed: compute charge per truck, then multiply by truck count.
  // Each truck requires its own repositioning leg.
  const transportDays = transportDaysFromDistance(order.distanceToNearestMarketMiles)
  const overnights = Math.max(transportDays - 1, 0)

  const chargePerTruck =
    transportDays * TRANSPORT_CONFIG.exceptionTransportDayRate
    + TRANSPORT_CONFIG.airfareHomeOneWay
    + overnights * TRANSPORT_CONFIG.hotelPerDiemPerNight

  const triggers: TransportTrigger[] = []
  if (isShortFlight) triggers.push('SHORT_FLIGHT')
  if (isRush) triggers.push('RUSH')
  if (isOutsideInclusionZone) triggers.push('OUTSIDE_INCLUSION_ZONE')

  const depositPerTruck = TRANSPORT_CONFIG.depositTransportDays * TRANSPORT_CONFIG.exceptionTransportDayRate

  return {
    outcome: 'BILLED',
    triggers,
    transportDays,
    chargePerTruck,
    transportCharge: chargePerTruck * order.simultaneousUnits,
    truckCount: order.simultaneousUnits,
    // Deposit required for rush or outside inclusion zone (higher cancellation risk)
    depositRequired: isRush || isOutsideInclusionZone,
    depositPerTruck,
    depositAmount: depositPerTruck * order.simultaneousUnits,
  }
}

// ---------------------------------------------------------------------------
// Cancellation charge (spec §5)
// ---------------------------------------------------------------------------

export function cancellationCharge(
  distanceToNearestMarketMiles: number,
  truckCount: number,
  dispatched: boolean,
): number {
  if (!dispatched) return 0

  const transportDays = transportDaysFromDistance(distanceToNearestMarketMiles)
  const perTruck =
    transportDays * TRANSPORT_CONFIG.exceptionTransportDayRate
    + TRANSPORT_CONFIG.airfareHomeOneWay
    + Math.max(transportDays - 1, 0) * TRANSPORT_CONFIG.hotelPerDiemPerNight
  return perTruck * truckCount
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

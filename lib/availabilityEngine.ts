/**
 * Deterministic availability engine.
 *
 * Replaces the AI's prose-based truck-by-truck availability checking with
 * structured code: date-overlap filtering, GPS-based proximity ranking,
 * per-truck transport pricing, and travel day blocking.
 *
 * Transport model:
 *   - Trucks within 250mi of the campaign market: transport absorbed (no charge)
 *   - Trucks beyond 250mi: transport billed per-truck based on actual distance
 *   - Travel days (ceil(distance / 450mi per day)) are checked against the
 *     truck's schedule — if the truck is booked during transit, it's excluded
 *   - Swarm: campaigns requesting more trucks than the market's base
 *     concurrency trigger a manual quote (enforced in priceTransport)
 *
 * Transport MATH lives in lib/pricing/transport.ts — this module only measures
 * distances and hands legs to that engine. It defines no pricing rules of its own.
 */

import { query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere } from '@/lib/holdFilters'
import { SCHEDULED_QUERY, CHAT_CONTEXT_QUERY } from '@/lib/scheduleQuery'
import { getLiveVehicleLocations, type SamsaraVehicleLocation } from '@/lib/samsaraService'
import { getMarketCoords } from '@/lib/marketCoordinates'
import {
  resolveNearestAcceptedMarket,
  resolveCampaignCoords,
  businessDaysBetween,
  type NearestMarketResult,
} from '@/lib/pricing/resolvers'
import { TRANSPORT_CONFIG } from '@/lib/pricing/config'
import {
  needsRepositioning,
  chargeForLeg,
  type TruckLeg,
} from '@/lib/pricing/transport'
import { buildTruckTimelines, type DayRow } from '@/lib/truckTimeline'
import { checkChainFeasibility, type ChainResult } from '@/lib/chainFeasibility'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIDDEN_TRUCKS = new Set(['0001', '0002', '1257', '00001257', '1991'])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProximityBucket = 'LOCAL' | 'NEARBY' | 'REPOSITIONING'

export type TruckTransport = {
  needed: boolean
  distanceMiles: number
  transportDays: number
  chargePerTruck: number
}

export type AvailableTruck = {
  truckNumber: string
  distanceMiles: number
  proximityBucket: ProximityBucket
  currentMarket: string
  hasGps: boolean
  /** Per-truck transport details (repositioning cost from this truck's release point) */
  transport: TruckTransport
  /** Where the truck departs from, and what this booking does to its next job. */
  chain: ChainResult
  /**
   * Feasible only by displacing a soft hold. Never selected automatically —
   * surfaced so a rep can make the call.
   */
  requiresOverride: boolean
}

/** A truck that cannot take the campaign, with the reason, for surfacing in the UI. */
export type InfeasibleTruck = {
  truckNumber: string
  currentMarket: string
  reason: 'CANNOT_ARRIVE' | 'STRANDS_SUCCESSOR' | 'UNKNOWN_ORIGIN' | 'BOOKED'
  detail: string
}

export type AvailabilityResult = {
  /** All available trucks ranked by proximity (closest first) */
  trucks: AvailableTruck[]
  /**
   * Trucks excluded for logistics reasons, with why. Never silently dropped —
   * an empty result with no explanation is what let the arrival gap hide.
   */
  infeasible: InfeasibleTruck[]
  /** Counts by proximity bucket */
  counts: {
    total: number
    local: number
    nearby: number
    repositioning: number
    cannotArrive: number
    wouldStrandSuccessor: number
  }
  /** Whether enough trucks are available to fill the request */
  sufficient: boolean
  /** Nearest accepted market to the campaign location */
  nearestAcceptedMarket: NearestMarketResult | null
  /** Campaign-level flags */
  campaignFlags: {
    shortFlight: boolean
    rush: boolean
    leadBusinessDays: number
  }
}

export type AvailabilityInput = {
  market: string              // e.g. "Dallas, TX"
  startDate: string           // YYYY-MM-DD
  endDate: string             // YYYY-MM-DD
  truckCount: number          // requested number of trucks
  serviceAreaMiles?: number   // override SERVICE_AREA_RADIUS_MILES (from rate card)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDateStr(val: unknown): string {
  if (!val) return ''
  if (val instanceof Date) return val.toISOString().split('T')[0]
  const s = String(val)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  try { return new Date(s).toISOString().split('T')[0] } catch { return '' }
}

function normalizeMarket(m: unknown): string {
  return String(m ?? '').replace(/\s*,\s*/g, ', ').trim()
}

function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd
}

function classifyDistance(distanceMiles: number, serviceAreaMiles?: number): ProximityBucket {
  if (needsRepositioning(distanceMiles, serviceAreaMiles)) return 'REPOSITIONING'
  return distanceMiles <= 50 ? 'LOCAL' : 'NEARBY'
}

/**
 * Convert selected trucks into transport legs for priceTransport().
 * This is the adapter for callers that HAVE real truck positions; callers
 * without truck selection use estimatedLegs() from lib/pricing/transport.
 */
export function legsFromTrucks(trucks: AvailableTruck[]): TruckLeg[] {
  return trucks.map(t => ({
    distanceMiles: t.distanceMiles,
    needsRepositioning: t.transport.needed,
    truckNumber: t.truckNumber,
    fromMarket: t.currentMarket || 'Unknown',
  }))
}

// ---------------------------------------------------------------------------
// Core availability check
// ---------------------------------------------------------------------------

export async function checkAvailability(input: AvailabilityInput): Promise<AvailabilityResult> {
  const { market, startDate, endDate, truckCount, serviceAreaMiles } = input

  // Resolve campaign market coordinates
  const campaignCoords = await resolveCampaignCoords(market)

  // Fetch all data sources in parallel
  const [scheduleRows, contextRows, holds, gpsMap, resolvedNearestMarket] = await Promise.all([
    query<Record<string, unknown>[]>(SCHEDULED_QUERY),
    query<Record<string, unknown>[]>(CHAT_CONTEXT_QUERY),
    prisma.hold.findMany({
      where: activeHoldWhere(),
      orderBy: { start_date: 'asc' },
    }),
    getLiveVehicleLocations().catch(() => new Map<string, SamsaraVehicleLocation>()),
    campaignCoords
      ? resolveNearestAcceptedMarket(campaignCoords.lat, campaignCoords.lng)
      : Promise.resolve(null),
  ])

  // Fallback for unknown markets — conservative 1000mi distance.
  // Also use the nearest accepted market's coords as a proxy for the campaign
  // location when exact coords aren't available, so truck distances can still
  // be computed (relative to the nearest DMA — a reasonable approximation).
  let nearestAcceptedMarket = resolvedNearestMarket
  const effectiveCampaignCoords = campaignCoords
  if (!nearestAcceptedMarket) {
    const fallbackMarket = await prisma.acceptedMarket.findFirst({ where: { is_active: true } })
    if (fallbackMarket) {
      nearestAcceptedMarket = {
        dma_name: fallbackMarket.dma_name,
        dma_code: fallbackMarket.dma_code,
        distanceMiles: 1000,
        baseConcurrency: fallbackMarket.base_concurrency,
        lat: fallbackMarket.lat,
        lng: fallbackMarket.lng,
      }
      // NOTE: we intentionally do NOT set effectiveCampaignCoords here.
      // Using a random DMA's coords as a proxy for an unknown city (e.g. Fairbanks)
      // would produce misleading truck distances. Instead, trucks will be skipped
      // (no location relative to campaign) and the quote will show the market as
      // unresolvable, requiring a manual quote for transport.
    }
  }

  // Build per-truck job timelines. Unlike a plain date range, each job carries
  // the market it happens in — that is what makes the chain check possible.
  const scheduleDays: DayRow[] = []
  for (const row of scheduleRows) {
    const truckNumber = String(row.truck_number ?? '')
    if (HIDDEN_TRUCKS.has(truckNumber)) continue
    const day = toDateStr(row.shift_start)
    if (!day) continue
    scheduleDays.push({
      truckNumber,
      date: day,
      market: normalizeMarket(row.standard_market_name || row.market),
      state: String(row.state ?? ''),
      program: String(row.program ?? ''),
    })
  }

  const timelines = buildTruckTimelines(
    scheduleDays,
    holds
      .filter(h => !HIDDEN_TRUCKS.has(h.truck_number))
      .map(h => ({
        truck_number: h.truck_number,
        start_date: toDateStr(h.start_date),
        end_date: toDateStr(h.end_date),
        market: normalizeMarket(h.market),
        state: String(h.state ?? ''),
        status: h.status,
      })),
  )

  const bookedByTruck = new Map<string, { start: string; end: string }[]>()
  for (const [truckNumber, jobs] of timelines) {
    bookedByTruck.set(truckNumber, jobs.map(j => ({ start: j.start, end: j.end })))
  }

  // Get all known truck numbers
  const allTruckNumbers = new Set<string>()
  for (const row of contextRows) {
    const truckNumber = String(row.truck_number ?? '')
    if (!HIDDEN_TRUCKS.has(truckNumber)) allTruckNumbers.add(truckNumber)
  }
  for (const truckNumber of bookedByTruck.keys()) {
    allTruckNumbers.add(truckNumber)
  }

  // Campaign-level flags
  const campaignDays = Math.round(
    (new Date(endDate + 'T00:00:00Z').getTime() - new Date(startDate + 'T00:00:00Z').getTime())
    / (1000 * 60 * 60 * 24)
  ) + 1
  const leadBusinessDays = businessDaysBetween(new Date(), new Date(startDate + 'T00:00:00Z'))
  const shortFlight = campaignDays < TRANSPORT_CONFIG.minFlightDays
  const rush = leadBusinessDays < TRANSPORT_CONFIG.standardLeadTimeBusinessDays
  // Swarm is evaluated in the quote route based on how many selected trucks
  // actually need repositioning — not here on the total request count.

  // Check each truck: campaign window free, can arrive, does not strand its next job
  const today = new Date().toISOString().split('T')[0]
  const availableTrucks: AvailableTruck[] = []
  const infeasible: InfeasibleTruck[] = []

  for (const truckNumber of allTruckNumbers) {
    const ranges = bookedByTruck.get(truckNumber) ?? []

    // Determine truck location
    const gps = gpsMap.get(truckNumber)
    let currentCoords: { lat: number; lng: number } | null = null
    let currentMarket = ''
    let hasGps = false

    if (gps?.latitude && gps?.longitude) {
      currentCoords = { lat: gps.latitude, lng: gps.longitude }
      currentMarket = [gps.city, gps.state].filter(Boolean).join(', ')
      hasGps = true
    } else {
      const contextRow = contextRows.find(r => String(r.truck_number ?? '') === truckNumber)
      const lastKnownMarket = normalizeMarket(contextRow?.last_known_market)
      if (lastKnownMarket) {
        currentCoords = getMarketCoords(lastKnownMarket) ?? null
        currentMarket = lastKnownMarket
      }
    }

    // Without campaign coordinates there is nothing to measure against — the
    // quote will fall back to a manual transport quote.
    if (!effectiveCampaignCoords) continue

    // Rule 2: the campaign window itself must be free.
    if (ranges.some(r => rangesOverlap(r.start, r.end, startDate, endDate))) {
      infeasible.push({
        truckNumber,
        currentMarket,
        reason: 'BOOKED',
        detail: `Already booked during ${startDate} to ${endDate}.`,
      })
      continue
    }

    // Rules 1 and 3: can it get there, and can it still make its next job?
    const chain = checkChainFeasibility({
      campaignStart: startDate,
      campaignEnd: endDate,
      campaignCoords: effectiveCampaignCoords,
      jobs: timelines.get(truckNumber) ?? [],
      currentCoords,
      today,
      serviceAreaMiles,
    })

    if (!chain.feasible && !chain.overridable) {
      infeasible.push({
        truckNumber,
        currentMarket,
        reason: chain.blockedBy ?? 'CANNOT_ARRIVE',
        detail: chain.detail ?? '',
      })
      continue
    }

    // Distance is measured from the RELEASE point, not live GPS — a truck
    // finishing in Miami is a Miami truck for the next campaign, and both the
    // feasibility check and the transport charge have to agree on that.
    const distanceMiles = chain.inbound.distanceMiles
    const bucket = classifyDistance(distanceMiles, serviceAreaMiles)
    const needsTransport = bucket === 'REPOSITIONING'

    const transport: TruckTransport = needsTransport
      ? {
          needed: true,
          distanceMiles,
          transportDays: chain.inbound.transportDays,
          chargePerTruck: chargeForLeg(distanceMiles),
        }
      : {
          needed: false,
          distanceMiles,
          transportDays: 0,
          chargePerTruck: 0,
        }

    availableTrucks.push({
      truckNumber,
      distanceMiles,
      proximityBucket: bucket,
      currentMarket,
      hasGps,
      transport,
      chain,
      requiresOverride: !chain.feasible && chain.overridable,
    })
  }

  // Sort by distance (closest first — cheapest trucks selected first)
  // Rank by what the booking actually costs across the chain, not by inbound
  // distance alone: a close truck with a distant next job can be the more
  // expensive choice. Trucks needing a soft-hold override always sort last —
  // they are options for a rep, never automatic picks.
  const chainCost = (t: AvailableTruck) =>
    t.transport.chargePerTruck + Math.max(0, t.chain.successor?.deltaCost ?? 0)

  availableTrucks.sort((a, b) =>
    Number(a.requiresOverride) - Number(b.requiresOverride)
    || chainCost(a) - chainCost(b)
    || a.distanceMiles - b.distanceMiles
  )

  const counts = {
    total: availableTrucks.length,
    local: availableTrucks.filter(t => t.proximityBucket === 'LOCAL').length,
    nearby: availableTrucks.filter(t => t.proximityBucket === 'NEARBY').length,
    repositioning: availableTrucks.filter(t => t.proximityBucket === 'REPOSITIONING').length,
    cannotArrive: infeasible.filter(t => t.reason === 'CANNOT_ARRIVE').length,
    wouldStrandSuccessor: infeasible.filter(t => t.reason === 'STRANDS_SUCCESSOR').length,
  }

  return {
    trucks: availableTrucks,
    infeasible,
    counts,
    sufficient: availableTrucks.filter(t => !t.requiresOverride).length >= truckCount,
    nearestAcceptedMarket,
    campaignFlags: { shortFlight, rush, leadBusinessDays },
  }
}

// ---------------------------------------------------------------------------
// Truck selection for hold placement
// ---------------------------------------------------------------------------

export async function selectTrucksForHold(input: AvailabilityInput): Promise<{
  selectedTrucks: AvailableTruck[]
  availability: AvailabilityResult
}> {
  const availability = await checkAvailability(input)
  // Only cleanly feasible trucks are auto-selected. Displacing a soft hold is a
  // decision for a rep, never something a quote or hold flow does on its own.
  const selectedTrucks = availability.trucks
    .filter(t => !t.requiresOverride)
    .slice(0, input.truckCount)
  return { selectedTrucks, availability }
}

// ---------------------------------------------------------------------------
// Single-truck feasibility — for write paths and audits
// ---------------------------------------------------------------------------

export type TruckFeasibility = {
  /** True when the booking can be placed without breaking anything. */
  ok: boolean
  /** True when the only blocker is a soft hold a rep may displace. */
  overridable: boolean
  reason?: 'CANNOT_ARRIVE' | 'STRANDS_SUCCESSOR' | 'UNKNOWN_ORIGIN' | 'UNRESOLVED_MARKET'
  detail?: string
}

/**
 * Evaluate one truck against one campaign, independent of the quote flow.
 *
 * checkAvailability() answers "which trucks could take this?"; this answers
 * "can THIS truck take this?", which is the question the hold write paths and
 * the infeasible-hold audit need. Both run the same chain rules.
 *
 * `excludeHoldId` lets an audit re-evaluate an existing hold without the hold
 * itself counting as its own predecessor or successor.
 */
export async function checkTruckFeasibility(params: {
  truckNumber: string
  market: string
  startDate: string
  endDate: string
  excludeHoldId?: string
  serviceAreaMiles?: number
}): Promise<TruckFeasibility> {
  const { truckNumber, market, startDate, endDate, excludeHoldId, serviceAreaMiles } = params

  const campaignCoords = await resolveCampaignCoords(market)
  if (!campaignCoords) {
    // Cannot place the campaign on a map — no chain check is possible. Not a
    // failure of the truck, so this never blocks on its own.
    return { ok: true, overridable: false, reason: 'UNRESOLVED_MARKET', detail: `Market "${market}" could not be geocoded — feasibility not checked.` }
  }

  const [scheduleRows, holds, gpsMap] = await Promise.all([
    query<Record<string, unknown>[]>(SCHEDULED_QUERY),
    prisma.hold.findMany({ where: activeHoldWhere(), orderBy: { start_date: 'asc' } }),
    getLiveVehicleLocations().catch(() => new Map<string, SamsaraVehicleLocation>()),
  ])

  const scheduleDays: DayRow[] = []
  for (const row of scheduleRows) {
    if (String(row.truck_number ?? '') !== truckNumber) continue
    const day = toDateStr(row.shift_start)
    if (!day) continue
    scheduleDays.push({
      truckNumber,
      date: day,
      market: normalizeMarket(row.standard_market_name || row.market),
      state: String(row.state ?? ''),
      program: String(row.program ?? ''),
    })
  }

  const timelines = buildTruckTimelines(
    scheduleDays,
    holds
      .filter(h => h.truck_number === truckNumber && h.id !== excludeHoldId)
      .map(h => ({
        truck_number: h.truck_number,
        start_date: toDateStr(h.start_date),
        end_date: toDateStr(h.end_date),
        market: normalizeMarket(h.market),
        state: String(h.state ?? ''),
        status: h.status,
      })),
  )

  const gps = gpsMap.get(truckNumber)
  const currentCoords = gps?.latitude && gps?.longitude
    ? { lat: gps.latitude, lng: gps.longitude }
    : null

  const chain = checkChainFeasibility({
    campaignStart: startDate,
    campaignEnd: endDate,
    campaignCoords,
    jobs: timelines.get(truckNumber) ?? [],
    currentCoords,
    today: new Date().toISOString().split('T')[0],
    serviceAreaMiles,
  })

  if (chain.feasible) return { ok: true, overridable: false }
  return {
    ok: false,
    overridable: chain.overridable,
    reason: chain.blockedBy,
    detail: chain.detail,
  }
}

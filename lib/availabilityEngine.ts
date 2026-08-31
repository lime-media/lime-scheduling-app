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
 *   - Swarm: campaigns requesting >3 trucks trigger manual quote
 *   - Short flight (<3 days) and rush (<10 biz day lead) still apply
 */

import { query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { SCHEDULED_QUERY, CHAT_CONTEXT_QUERY } from '@/lib/scheduleQuery'
import { getLiveVehicleLocations, type SamsaraVehicleLocation } from '@/lib/samsaraService'
import { haversineDistance, getMarketCoords } from '@/lib/marketCoordinates'
import {
  resolveNearestAcceptedMarket,
  resolveCampaignCoords,
  businessDaysBetween,
  type NearestMarketResult,
} from '@/lib/pricing/resolvers'
import {
  SERVICE_AREA_RADIUS_MILES,
  TRANSPORT_CONFIG,
} from '@/lib/pricing/config'

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
  /** Per-truck transport details (repositioning cost from this truck's location) */
  transport: TruckTransport
}

export type AvailabilityResult = {
  /** All available trucks ranked by proximity (closest first) */
  trucks: AvailableTruck[]
  /** Counts by proximity bucket */
  counts: {
    total: number
    local: number
    nearby: number
    repositioning: number
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

function classifyDistance(distanceMiles: number): ProximityBucket {
  if (distanceMiles <= 50) return 'LOCAL'
  if (distanceMiles <= SERVICE_AREA_RADIUS_MILES) return 'NEARBY'
  return 'REPOSITIONING'
}

/** Subtract N calendar days from a YYYY-MM-DD string */
function subtractDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().split('T')[0]
}

function transportDaysFromDistance(distanceMiles: number): number {
  return Math.max(1, Math.ceil(distanceMiles / TRANSPORT_CONFIG.transportDay.milesPerDay))
}

function computePerTruckTransportCharge(distanceMiles: number): number {
  const days = transportDaysFromDistance(distanceMiles)
  const overnights = Math.max(days - 1, 0)
  return (
    days * TRANSPORT_CONFIG.exceptionTransportDayRate
    + TRANSPORT_CONFIG.airfareHomeOneWay
    + overnights * TRANSPORT_CONFIG.hotelPerDiemPerNight
  )
}

// ---------------------------------------------------------------------------
// Core availability check
// ---------------------------------------------------------------------------

export async function checkAvailability(input: AvailabilityInput): Promise<AvailabilityResult> {
  const { market, startDate, endDate, truckCount } = input

  // Resolve campaign market coordinates
  const campaignCoords = await resolveCampaignCoords(market)

  // Fetch all data sources in parallel
  const [scheduleRows, contextRows, holds, otherRequests, gpsMap, resolvedNearestMarket] = await Promise.all([
    query<Record<string, unknown>[]>(SCHEDULED_QUERY),
    query<Record<string, unknown>[]>(CHAT_CONTEXT_QUERY),
    prisma.hold.findMany({
      where: { status: { not: 'EXPIRED' } },
      orderBy: { start_date: 'asc' },
    }),
    // Include ALL non-rejected hold requests (including the requesting client's own)
    // so a truck with an existing pending hold is not selected again.
    prisma.holdRequest.findMany({
      where: { status: { not: 'REJECTED' } },
      orderBy: { created_at: 'asc' },
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
  let effectiveCampaignCoords = campaignCoords
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

  // Build per-truck booked date ranges
  type BookedRange = { start: string; end: string }
  const bookedByTruck = new Map<string, BookedRange[]>()

  const addBooking = (truckNumber: string, start: string, end: string) => {
    if (HIDDEN_TRUCKS.has(truckNumber)) return
    if (!start || !end) return
    const ranges = bookedByTruck.get(truckNumber) ?? []
    ranges.push({ start, end })
    bookedByTruck.set(truckNumber, ranges)
  }

  for (const row of scheduleRows) {
    const truckNumber = String(row.truck_number ?? '')
    const day = toDateStr(row.shift_start)
    if (day) addBooking(truckNumber, day, day)
  }

  for (const h of holds) {
    addBooking(h.truck_number, toDateStr(h.start_date), toDateStr(h.end_date))
  }

  for (const r of otherRequests) {
    addBooking(r.truck_number, toDateStr(r.start_date), toDateStr(r.end_date))
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

  // Check each truck: date availability + proximity + travel day blocking
  const availableTrucks: AvailableTruck[] = []

  for (const truckNumber of allTruckNumbers) {
    const ranges = bookedByTruck.get(truckNumber) ?? []

    // Determine truck location
    const gps = gpsMap.get(truckNumber)
    let distanceMiles = Infinity
    let currentMarket = ''
    let hasGps = false

    if (gps?.latitude && gps?.longitude && effectiveCampaignCoords) {
      distanceMiles = haversineDistance(gps.latitude, gps.longitude, effectiveCampaignCoords.lat, effectiveCampaignCoords.lng)
      currentMarket = [gps.city, gps.state].filter(Boolean).join(', ')
      hasGps = true
    } else if (effectiveCampaignCoords) {
      const contextRow = contextRows.find(r => String(r.truck_number ?? '') === truckNumber)
      const lastKnownMarket = normalizeMarket(contextRow?.last_known_market)
      if (lastKnownMarket) {
        const lkmCoords = getMarketCoords(lastKnownMarket)
        if (lkmCoords) {
          distanceMiles = haversineDistance(lkmCoords.lat, lkmCoords.lng, effectiveCampaignCoords.lat, effectiveCampaignCoords.lng)
        }
        currentMarket = lastKnownMarket
      }
    } else {
      if (gps?.city) {
        currentMarket = [gps.city, gps.state].filter(Boolean).join(', ')
        hasGps = true
      }
    }

    // Trucks with no location data at all — skip them, we can't plan logistics
    if (!Number.isFinite(distanceMiles)) continue

    distanceMiles = Math.round(distanceMiles * 10) / 10
    const bucket = classifyDistance(distanceMiles)

    // Compute travel days needed for repositioning
    const travelDays = bucket === 'REPOSITIONING'
      ? transportDaysFromDistance(distanceMiles)
      : 0

    // Check availability: campaign dates + travel days before campaign start.
    // The truck must be free for the campaign AND the transit period.
    const effectiveStart = travelDays > 0
      ? subtractDays(startDate, travelDays)
      : startDate

    const hasConflict = ranges.some(r => rangesOverlap(r.start, r.end, effectiveStart, endDate))
    if (hasConflict) continue

    // Compute per-truck transport
    const needsTransport = bucket === 'REPOSITIONING'
    const transport: TruckTransport = needsTransport
      ? {
          needed: true,
          distanceMiles,
          transportDays: travelDays,
          chargePerTruck: computePerTruckTransportCharge(distanceMiles),
        }
      : {
          needed: false,
          distanceMiles,
          transportDays: 0,
          chargePerTruck: 0,
        }

    // Short flight and rush surcharges apply even to local trucks — these are
    // campaign-level triggers that add cost on top of per-truck repo.
    // They're surfaced as campaign flags, not per-truck charges.

    availableTrucks.push({
      truckNumber,
      distanceMiles,
      proximityBucket: bucket,
      currentMarket,
      hasGps,
      transport,
    })
  }

  // Sort by distance (closest first — cheapest trucks selected first)
  availableTrucks.sort((a, b) => a.distanceMiles - b.distanceMiles)

  const counts = {
    total: availableTrucks.length,
    local: availableTrucks.filter(t => t.proximityBucket === 'LOCAL').length,
    nearby: availableTrucks.filter(t => t.proximityBucket === 'NEARBY').length,
    repositioning: availableTrucks.filter(t => t.proximityBucket === 'REPOSITIONING').length,
  }

  return {
    trucks: availableTrucks,
    counts,
    sufficient: availableTrucks.length >= truckCount,
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
  const selectedTrucks = availability.trucks.slice(0, input.truckCount)
  return { selectedTrucks, availability }
}

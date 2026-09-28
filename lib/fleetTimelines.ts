/**
 * One place that loads the fleet's job timelines.
 *
 * Three callers need "every truck's jobs, with markets, in date order": the
 * availability engine, the single-truck feasibility check, and the infeasible
 * hold audit. Loading it three times is how the transport duplication started,
 * so it loads here once.
 *
 * The schedule window is deliberately wider than any campaign being evaluated —
 * chain feasibility needs the job BEFORE and the job AFTER, which by definition
 * fall outside the campaign's own dates.
 */

import { prisma } from '@/lib/prisma'
import { query } from '@/lib/mssql'
import { activeHoldWhere } from '@/lib/holdFilters'
import { scheduledWithMarketQuery } from '@/lib/scheduleQuery'
import { hasMarketBounds, loadStandardMarketCoords, normalizeMarketKey } from '@/lib/marketBounds'
import { getLiveVehicleLocations, type SamsaraVehicleLocation } from '@/lib/samsaraService'
import { buildTruckTimelines, type DayRow, type TruckJob } from '@/lib/truckTimeline'

export type FleetHold = {
  id: string
  truck_number: string
  start_date: string
  end_date: string
  market: string
  state: string
  status: string
  client_name: string
  origination: string
  source: string
  lat?: number
  lng?: number
}

export type FleetTimelines = {
  timelines: Map<string, TruckJob[]>
  gpsMap: Map<string, SamsaraVehicleLocation>
  /** The active holds the timelines were built from, normalized to date strings. */
  holds: FleetHold[]
}

function toDateStr(val: unknown): string {
  if (!val) return ''
  if (val instanceof Date) return val.toISOString().split('T')[0]
  const s = String(val)
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ''
}

function normalizeMarket(m: unknown): string {
  return String(m ?? '').replace(/\s*,\s*/g, ', ').trim()
}

export async function loadFleetTimelines(opts: {
  hiddenTrucks?: Set<string>
  /** Omit this hold from the timelines — used when re-evaluating that hold. */
  excludeHoldId?: string
  /**
   * Explicit schedule window (YYYY-MM-DD, inclusive) instead of the rolling
   * -30/+63 days. For planning programs that run past the rolling window; the
   * windowed load also carries each job's booking client.
   */
  window?: { start: string; end: string }
} = {}): Promise<FleetTimelines> {
  const hidden = opts.hiddenTrucks ?? new Set<string>()
  const window = opts.window

  // Ask the database what it can give us before asking for it.
  const withBounds = await hasMarketBounds()

  const [marketCoords, [scheduleRows, holds, gpsMap]] = await Promise.all([
    // Holds carry no standard_market_uid, so their markets are matched by name
    // against the authoritative list rather than the hardcoded file.
    loadStandardMarketCoords(),
    Promise.all([
    window
      ? query<Record<string, unknown>[]>(scheduledWithMarketQuery(withBounds, true), {
          windowStart: window.start,
          windowEnd: window.end,
        })
      : query<Record<string, unknown>[]>(scheduledWithMarketQuery(withBounds)),
    prisma.hold.findMany({ where: activeHoldWhere(), orderBy: { start_date: 'asc' } }),
    getLiveVehicleLocations().catch(() => new Map<string, SamsaraVehicleLocation>()),
    ] as const),
  ])

  const scheduleDays: DayRow[] = []
  for (const row of scheduleRows) {
    const truckNumber = String(row.truck_number ?? '')
    if (!truckNumber || hidden.has(truckNumber)) continue
    const day = toDateStr(row.shift_start)
    if (!day) continue
    const lat = Number(row.market_lat)
    const lng = Number(row.market_lng)
    scheduleDays.push({
      truckNumber,
      date: day,
      market: normalizeMarket(row.standard_market_name || row.market),
      state: String(row.state ?? ''),
      program: String(row.program ?? ''),
      client: window ? String(row.client ?? '') : undefined,
      // Only when the database supplied them AND they are real numbers; a
      // market row with null bounds behaves exactly like the columns being absent.
      lat: Number.isFinite(lat) && row.market_lat != null ? lat : undefined,
      lng: Number.isFinite(lng) && row.market_lng != null ? lng : undefined,
    })
  }

  const fleetHolds: FleetHold[] = holds
    .filter(h => !hidden.has(h.truck_number))
    .map(h => {
      const market = normalizeMarket(h.market)
      const state = String(h.state ?? '')
      // Try "market, state" then the market alone — hold markets are free text
      // and may or may not already carry the state.
      const coords =
        marketCoords.get(normalizeMarketKey(state && !market.toLowerCase().endsWith(`, ${state.toLowerCase()}`) ? `${market}, ${state}` : market))
        ?? marketCoords.get(normalizeMarketKey(market))
      return {
        id: h.id,
        truck_number: h.truck_number,
        start_date: toDateStr(h.start_date),
        end_date: toDateStr(h.end_date),
        market,
        state,
        status: h.status,
        client_name: h.client_name,
        origination: h.origination,
        source: h.source,
        lat: coords?.lat,
        lng: coords?.lng,
      }
    })

  const timelines = buildTruckTimelines(
    scheduleDays,
    fleetHolds.filter(h => h.id !== opts.excludeHoldId),
  )

  return { timelines, gpsMap, holds: fleetHolds }
}

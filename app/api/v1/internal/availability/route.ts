import { NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere } from '@/lib/holdFilters'
import { ALL_TRUCKS_QUERY } from '@/lib/scheduleQuery'
import { getLiveVehicleLocations } from '@/lib/samsaraService'
import { loadFleetTimelines } from '@/lib/fleetTimelines'
import { checkChainFeasibility } from '@/lib/chainFeasibility'
import { resolveCampaignCoords } from '@/lib/pricing/resolvers'

const HIDDEN_TRUCKS = new Set(['0001', '0002', '1257', '00001257', '1991'])

function normalizeMarket(m: unknown): string {
  return String(m ?? '').replace(/\s*,\s*/g, ', ').trim()
}

function toDateStr(val: unknown): string {
  if (!val) return ''
  if (val instanceof Date) return val.toISOString().split('T')[0]
  const s = String(val)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  try { return new Date(s).toISOString().split('T')[0] } catch { return '' }
}

// Parameterized query: schedule blocks within a specific date range
const SCHEDULE_RANGE_QUERY = `
SELECT
    t.truck_number,
    COALESCE(cpm.market,               '') AS market,
    COALESCE(cpm.standard_market_name, '') AS standard_market_name,
    CAST(ps.start_time AS DATE) AS shift_start,
    CAST(ps.start_time AS DATE) AS shift_end
FROM dbo.program_schedule ps
JOIN dbo.trucks t
    ON  t.truck_uid = ps.truck_uid
LEFT JOIN dbo.client_program_markets cpm
    ON  cpm.client_program_market_uid = ps.client_program_market_uid
WHERE CAST(ps.start_time AS DATE) <= @endDate
  AND CAST(ps.end_time   AS DATE) >= @startDate
ORDER BY t.truck_number, ps.start_time
`

export async function GET(request: Request) {
  const authError = validateInternalApiKey(request)
  if (authError) return authError

  const { searchParams } = new URL(request.url)
  const startDate = searchParams.get('start_date')
  const endDate = searchParams.get('end_date')

  if (!startDate || !endDate) {
    return NextResponse.json(
      { error: 'start_date and end_date query params are required (ISO format: YYYY-MM-DD)' },
      { status: 400 }
    )
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return NextResponse.json(
      { error: 'start_date and end_date must be in YYYY-MM-DD format' },
      { status: 400 }
    )
  }

  if (startDate > endDate) {
    return NextResponse.json(
      { error: 'start_date must be before or equal to end_date' },
      { status: 400 }
    )
  }

  // Optional. Without it this endpoint answers "when is each truck booked?",
  // which says nothing about whether a truck could actually serve a campaign.
  // With it, every truck is additionally run through the same chain feasibility
  // rules the quote and hold paths use: can it arrive, and does taking it strand
  // the job it is already committed to. Callers that omit `market` get the
  // calendar view unchanged.
  const market = searchParams.get('market')

  const unitIdsParam = searchParams.get('unit_ids')
  const unitIdFilter = unitIdsParam
    ? new Set(unitIdsParam.split(',').map((id) => id.trim()))
    : null

  try {
    const now = new Date()

    // Fetch schedule blocks, holds, and truck list in parallel
    const [schedulesRaw, holds, trucksRaw] = await Promise.all([
      query<Record<string, unknown>[]>(SCHEDULE_RANGE_QUERY, {
        startDate,
        endDate,
      }),
      prisma.hold.findMany({
        where: {
          start_date: { lte: new Date(endDate + 'T23:59:59Z') },
          end_date: { gte: new Date(startDate + 'T00:00:00Z') },
          // Released holds don't make a truck unavailable to partners — that covers
          // both status EXPIRED and a hold whose expires_at has already passed.
          ...activeHoldWhere(),
        },
        orderBy: { start_date: 'asc' },
      }),
      query<Record<string, unknown>[]>(ALL_TRUCKS_QUERY),
    ])

    // Build projected market per truck (same cascade as inventory endpoint)
    let gpsMap = new Map<string, { city: string; state: string }>()
    try {
      gpsMap = await getLiveVehicleLocations()
    } catch {
      // Continue without GPS
    }

    const todayStr = now.toISOString().split('T')[0]
    const scheduleMarkets: Record<string, { market: string; shift_start: string }> = {}
    for (const row of schedulesRaw) {
      const num = String(row.truck_number ?? '')
      const shiftStart = toDateStr(row.shift_start)
      if (shiftStart > todayStr) continue
      const existing = scheduleMarkets[num]
      if (!existing || shiftStart > existing.shift_start) {
        scheduleMarkets[num] = {
          market: normalizeMarket(row.standard_market_name) || normalizeMarket(row.market),
          shift_start: shiftStart,
        }
      }
    }

    const holdMarkets: Record<string, string> = {}
    for (const h of holds) {
      if (!holdMarkets[h.truck_number]) {
        holdMarkets[h.truck_number] = h.market
      }
    }

    // Group schedule blocks by truck
    const schedulesByTruck: Record<string, { start_date: string; end_date: string }[]> = {}
    for (const row of schedulesRaw) {
      const num = String(row.truck_number ?? '')
      if (HIDDEN_TRUCKS.has(num)) continue
      if (unitIdFilter && !unitIdFilter.has(num)) continue
      if (!schedulesByTruck[num]) schedulesByTruck[num] = []
      schedulesByTruck[num].push({
        start_date: toDateStr(row.shift_start),
        end_date: toDateStr(row.shift_end),
      })
    }

    // Group holds by truck
    const holdsByTruck: Record<string, { start_date: string; end_date: string }[]> = {}
    for (const h of holds) {
      if (HIDDEN_TRUCKS.has(h.truck_number)) continue
      if (unitIdFilter && !unitIdFilter.has(h.truck_number)) continue
      if (!holdsByTruck[h.truck_number]) holdsByTruck[h.truck_number] = []
      holdsByTruck[h.truck_number].push({
        start_date: h.start_date.toISOString().split('T')[0],
        end_date: h.end_date.toISOString().split('T')[0],
      })
    }

    // Feasibility pass — only when a market was supplied.
    type FeasibilityEntry = {
      can_serve: boolean
      reason?: string
      detail?: string
      requires_soft_hold_override: boolean
      departs_from: string
      transport_days: number
      distance_miles: number
      priced_from_gps_fallback?: string
    }
    const feasibilityByTruck = new Map<string, FeasibilityEntry>()
    let marketResolved = false

    if (market) {
      const campaignCoords = await resolveCampaignCoords(market)
      if (campaignCoords) {
        marketResolved = true
        const { timelines, gpsMap: fleetGps } = await loadFleetTimelines({ hiddenTrucks: HIDDEN_TRUCKS })
        const today = new Date().toISOString().split('T')[0]

        for (const num of trucksRaw.map(r => String(r.truck_number ?? ''))) {
          if (!num || HIDDEN_TRUCKS.has(num)) continue
          if (unitIdFilter && !unitIdFilter.has(num)) continue

          const truckGps = fleetGps.get(num)
          const chain = checkChainFeasibility({
            campaignStart: startDate,
            campaignEnd: endDate,
            campaignCoords,
            jobs: timelines.get(num) ?? [],
            currentCoords: truckGps?.latitude && truckGps?.longitude
              ? { lat: truckGps.latitude, lng: truckGps.longitude }
              : null,
            today,
          })

          feasibilityByTruck.set(num, {
            can_serve: chain.feasible,
            reason: chain.blockedBy,
            detail: chain.detail,
            requires_soft_hold_override: !chain.feasible && chain.overridable,
            departs_from: chain.inbound.originLabel,
            transport_days: chain.inbound.transportDays,
            distance_miles: chain.inbound.distanceMiles,
            priced_from_gps_fallback: chain.inbound.originFellBackToGps,
          })
        }
      }
    }

    // Build the response: one entry per requested truck
    const activeTrucks = trucksRaw
      .map((r) => String(r.truck_number ?? ''))
      .filter((num) => !HIDDEN_TRUCKS.has(num))
      .filter((num) => !unitIdFilter || unitIdFilter.has(num))

    const trucks = activeTrucks.map((num) => {
      const scheduleBlocks = schedulesByTruck[num] || []
      const holdBlocks = holdsByTruck[num] || []

      // Merge all booked intervals and collapse into non-overlapping spans
      const allIntervals = [...scheduleBlocks, ...holdBlocks]
        .map((b) => ({
          start_date: clampDate(b.start_date, startDate, endDate),
          end_date: clampDate(b.end_date, startDate, endDate),
        }))
        .filter((b) => b.start_date <= b.end_date)
        .sort((a, b) => a.start_date.localeCompare(b.start_date))

      const merged = mergeIntervals(allIntervals)

      const gpsData = gpsMap.get(num)
      const projectedMarket =
        scheduleMarkets[num]?.market ||
        holdMarkets[num] ||
        (gpsData?.city ? [gpsData.city, gpsData.state].filter(Boolean).join(', ') : null)

      return {
        unit_id: num,
        projected_market_during_range: projectedMarket,
        booked_intervals: merged.map((b) => ({
          start_date: b.start_date,
          end_date: b.end_date,
          status: 'unavailable' as const,
        })),
        // Present only when `market` was supplied.
        ...(feasibilityByTruck.has(num) ? { feasibility: feasibilityByTruck.get(num) } : {}),
      }
    })

    return NextResponse.json({
      trucks,
      query_range: { start_date: startDate, end_date: endDate },
      // Tells the caller whether can_serve was actually evaluated. A free
      // calendar slot is NOT the same as a truck that can serve the market.
      feasibility_checked: Boolean(market) && marketResolved,
      ...(market && !marketResolved
        ? { feasibility_warning: `Market "${market}" could not be geocoded — feasibility not evaluated.` }
        : {}),
      generated_at: now.toISOString(),
    })
  } catch (error) {
    console.error('[v1/internal/availability] Error:', error)
    return NextResponse.json({ error: 'Failed to fetch availability' }, { status: 500 })
  }
}

/** Clamp a date string to within [rangeStart, rangeEnd] */
function clampDate(date: string, rangeStart: string, rangeEnd: string): string {
  if (date < rangeStart) return rangeStart
  if (date > rangeEnd) return rangeEnd
  return date
}

/** Merge overlapping or adjacent date intervals into non-overlapping spans */
function mergeIntervals(
  intervals: { start_date: string; end_date: string }[]
): { start_date: string; end_date: string }[] {
  if (intervals.length === 0) return []

  const merged: { start_date: string; end_date: string }[] = [{ ...intervals[0] }]

  for (let i = 1; i < intervals.length; i++) {
    const current = intervals[i]
    const last = merged[merged.length - 1]

    // Adjacent dates (end + 1 day = next start) should also merge
    const lastEndNext = nextDay(last.end_date)
    if (current.start_date <= lastEndNext) {
      last.end_date = current.end_date > last.end_date ? current.end_date : last.end_date
    } else {
      merged.push({ ...current })
    }
  }

  return merged
}

/** Return the next calendar day as YYYY-MM-DD */
function nextDay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().split('T')[0]
}

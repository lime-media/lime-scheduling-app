import { NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { ALL_TRUCKS_QUERY } from '@/lib/scheduleQuery'
import { getLiveVehicleLocations } from '@/lib/samsaraService'

const HIDDEN_TRUCKS = new Set(['0001'])

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
      }
    })

    return NextResponse.json({
      trucks,
      query_range: { start_date: startDate, end_date: endDate },
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

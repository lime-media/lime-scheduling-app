import { partnerClashDetail } from '@/lib/bookingRefusals'
import { NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere } from '@/lib/holdFilters'
import { ALL_TRUCKS_QUERY, shiftDay, shiftDayIn } from '@/lib/scheduleQuery'
import { centralDate } from '@/lib/dateOnly'
import { getLiveVehicleLocations } from '@/lib/samsaraService'
import { loadFleetTimelines } from '@/lib/fleetTimelines'
import { checkChainFeasibility } from '@/lib/chainFeasibility'
import { findWindowClash } from '@/lib/truckTimeline'
import { resolveCampaignCoords, resolveDefaultRateOverrides } from '@/lib/pricing/resolvers'
import { mcpParty, parseMcpCampaign } from '@/lib/mcpActing'
import { clientAvailability } from '@/lib/clientAvailability'
import { checkAvailability } from '@/lib/availabilityEngine'
import { resolveQuoteMarket } from '@/lib/staffQuote'
import { HIDDEN_TRUCKS } from '@/lib/hiddenTrucks'

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
    ${shiftDay('ps.start_time')} AS shift_start,
    ${shiftDay('ps.start_time')} AS shift_end
FROM dbo.program_schedule ps
JOIN dbo.trucks t
    ON  t.truck_uid = ps.truck_uid
LEFT JOIN dbo.client_program_markets cpm
    ON  cpm.client_program_market_uid = ps.client_program_market_uid
WHERE ${shiftDayIn({ from: '@startDate', to: '@endDate' })}
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

  // With a market AND a truck count, the answer is the engine's, for whoever
  // the call acts for: what the client portal's quote form or the Quote page
  // would say about booking it (engineAnswer below). Without a truck count,
  // the calendar view follows.
  const truckCountParam = searchParams.get('truck_count')
  const engineMarket = searchParams.get('market')
  if (truckCountParam !== null && engineMarket) {
    if (!/^\d+$/.test(truckCountParam) || Number(truckCountParam) < 1) {
      return NextResponse.json({ error: 'truck_count must be a whole number of at least 1' }, { status: 400 })
    }
    // Real calendar dates (the regex above lets "2026-02-31" through) and a
    // trimmed market, by the same check as the quote and the booking.
    const q = parseMcpCampaign({ market: engineMarket, start_date: startDate, end_date: endDate, truck_count: Number(truckCountParam) })
    if ('error' in q) return NextResponse.json({ error: q.error }, { status: 400 })
    return engineAnswer(request, q)
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

    const todayStr = centralDate(now)  // shift days are local dates (lib/scheduleQuery.ts shiftDay)
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
        const today = centralDate(new Date())

        for (const num of trucksRaw.map(r => String(r.truck_number ?? ''))) {
          if (!num || HIDDEN_TRUCKS.has(num)) continue
          if (unitIdFilter && !unitIdFilter.has(num)) continue

          const truckJobs = timelines.get(num) ?? []

          // The window itself — checkChainFeasibility does not test it.
          const clash = findWindowClash(truckJobs, startDate, endDate)
          if (clash) {
            feasibilityByTruck.set(num, {
              can_serve: false,
              reason: 'BOOKED',
              detail: partnerClashDetail(clash),
              // Kept for compatibility; always false. The partner/MCP API can
              // never book over an AT&T soft hold (see lib/attSoftRelease.ts).
              requires_soft_hold_override: false,
              departs_from: 'n/a',
              transport_days: 0,
              distance_miles: 0,
            })
            continue
          }

          const truckGps = fleetGps.get(num)
          const chain = checkChainFeasibility({
            campaignStart: startDate,
            campaignEnd: endDate,
            campaignCoords,
            jobs: truckJobs,
            currentCoords: truckGps?.latitude && truckGps?.longitude
              ? { lat: truckGps.latitude, lng: truckGps.longitude }
              : null,
            today,
          })

          feasibilityByTruck.set(num, {
            can_serve: chain.feasible,
            reason: chain.blockedBy,
            // Stranding an AT&T soft hold is not offered to partners either.
            detail: !chain.feasible && chain.overridable ? 'Not available on these dates.' : chain.detail,
            requires_soft_hold_override: false,
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

/**
 * The engine's answer for one market, dates and truck count.
 * - A client gets the client portal's rules (lib/clientAvailability.ts: lead
 *   time, their rate card's service area, no displacing an AT&T soft hold) and,
 *   as on the quote form, only yes or the refusal message: no truck numbers or
 *   fleet counts.
 * - Staff get the Quote page's rules and the trucks, nearest first, with
 *   distance from where each is released, and the ones that can't take it.
 */
async function engineAnswer(request: Request, q: { market: string; start_date: string; end_date: string; truck_count: number }) {
  const party = await mcpParty(request)
  if (party.kind === 'error') return NextResponse.json({ error: party.error }, { status: party.status })

  if (party.kind === 'client') {
    const checked = await clientAvailability(party.session, q)
    if (checked.refused) {
      const b = checked.refused.body
      return NextResponse.json({ can_book: false, message: b.message ?? b.error, candidates: b.candidates }, { status: checked.refused.status })
    }
    return NextResponse.json({ can_book: true, market: checked.formalMarket, truck_count: q.truck_count, message: `${q.truck_count} truck${q.truck_count === 1 ? '' : 's'} can be booked in ${checked.formalMarket} for these dates.` })
  }

  const resolved = await resolveQuoteMarket(q.market)
  if ('status' in resolved) return NextResponse.json(resolved.body, { status: resolved.status })
  const defaults = await resolveDefaultRateOverrides()
  const a = await checkAvailability({
    market: resolved.formal, startDate: q.start_date, endDate: q.end_date, truckCount: q.truck_count,
    serviceAreaMiles: defaults?.service_area_miles,
    // The staff rule, as on the Quote page: leaving a later AT&T soft hold short is a warning.
    softHoldStrandIsWarning: true,
  })
  if (!a.marketResolved) return NextResponse.json({ can_book: false, message: `Could not locate "${resolved.formal}" on the map.` })
  return NextResponse.json({
    can_book: a.sufficient,
    market: resolved.formal,
    requested: q.truck_count,
    counts: a.counts,
    // The engine already leaves out hidden trucks (lib/hiddenTrucks.ts).
    trucks: a.trucks.slice(0, 25).map(t => ({
      unit_id: t.truckNumber, released_from: t.currentMarket || 'Unknown', miles: Math.round(t.distanceMiles),
      proximity: t.proximityBucket, needs_att_soft_release: t.requiresOverride, note: t.overrideDetail || t.softHoldWarning || undefined,
    })),
    cannot_take: a.infeasible.slice(0, 25).map(t => ({ unit_id: t.truckNumber, from: t.currentMarket || 'Unknown', reason: t.reason, detail: t.detail, earliest_start: t.earliestStart, latest_end: t.latestEnd })),
    date_options: a.dateOptions,
  })
}

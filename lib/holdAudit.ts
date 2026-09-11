/**
 * Infeasible-hold audit.
 *
 * Mirror paths (Salesforce pushes, ATT sync) write holds without the chain
 * feasibility gate, because refusing them would drop a booking the upstream
 * system already believes exists. This recomputes feasibility across every
 * active hold so those land on a review list instead of disappearing.
 *
 * Deliberately NOT a stored flag on the Hold row. Feasibility is a property of
 * the whole chain, so a flag written at insert time goes stale the moment a
 * neighbouring job moves, extends or cancels — the same reason transit days are
 * not written into the calendar. Recomputing is always current.
 */

import { prisma } from '@/lib/prisma'
import { query } from '@/lib/mssql'
import { activeHoldWhere } from '@/lib/holdFilters'
import { SCHEDULED_QUERY } from '@/lib/scheduleQuery'
import { getLiveVehicleLocations, type SamsaraVehicleLocation } from '@/lib/samsaraService'
import { resolveCampaignCoords } from '@/lib/pricing/resolvers'
import { buildTruckTimelines, type DayRow, type TruckJob } from '@/lib/truckTimeline'
import { checkChainFeasibility } from '@/lib/chainFeasibility'

export type InfeasibleHold = {
  holdId: string
  truckNumber: string
  clientName: string
  market: string
  startDate: string
  endDate: string
  status: string
  origination: string
  reason: string
  detail: string
  /** True when the blocker is a soft hold — resolvable without moving this booking. */
  overridable: boolean
}

export type HoldAuditResult = {
  checked: number
  infeasible: InfeasibleHold[]
  /** Holds skipped because their market could not be geocoded. */
  unresolvedMarkets: { holdId: string; market: string }[]
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

/**
 * Re-evaluate every active hold whose campaign has not already ended.
 * Each hold is checked against its truck's other jobs, excluding itself.
 */
export async function auditHoldFeasibility(): Promise<HoldAuditResult> {
  const today = new Date().toISOString().split('T')[0]

  const [scheduleRows, holds, gpsMap] = await Promise.all([
    query<Record<string, unknown>[]>(SCHEDULED_QUERY),
    prisma.hold.findMany({ where: activeHoldWhere(), orderBy: { start_date: 'asc' } }),
    getLiveVehicleLocations().catch(() => new Map<string, SamsaraVehicleLocation>()),
  ])

  const scheduleDays: DayRow[] = []
  for (const row of scheduleRows) {
    const truckNumber = String(row.truck_number ?? '')
    const day = toDateStr(row.shift_start)
    if (!truckNumber || !day) continue
    scheduleDays.push({
      truckNumber,
      date: day,
      market: normalizeMarket(row.standard_market_name || row.market),
      state: String(row.state ?? ''),
      program: String(row.program ?? ''),
    })
  }

  const holdRows = holds.map(h => ({
    id: h.id,
    truck_number: h.truck_number,
    start_date: toDateStr(h.start_date),
    end_date: toDateStr(h.end_date),
    market: normalizeMarket(h.market),
    state: String(h.state ?? ''),
    status: h.status,
    client_name: h.client_name,
    origination: h.origination,
  }))

  // Full timelines once; each hold is then removed from its own truck's chain.
  const allTimelines = buildTruckTimelines(scheduleDays, holdRows)

  const coordCache = new Map<string, Awaited<ReturnType<typeof resolveCampaignCoords>>>()
  async function coordsFor(market: string) {
    if (!coordCache.has(market)) coordCache.set(market, await resolveCampaignCoords(market))
    return coordCache.get(market)!
  }

  const infeasible: InfeasibleHold[] = []
  const unresolvedMarkets: { holdId: string; market: string }[] = []
  let checked = 0

  for (const h of holdRows) {
    if (!h.start_date || !h.end_date) continue
    if (h.end_date < today) continue // already in the past — nothing to fix

    const campaignCoords = await coordsFor(h.market)
    if (!campaignCoords) {
      unresolvedMarkets.push({ holdId: h.id, market: h.market })
      continue
    }

    // The hold under test must not appear in its own chain.
    const jobs: TruckJob[] = (allTimelines.get(h.truck_number) ?? []).filter(
      j => !(j.source === 'HOLD' && j.start === h.start_date && j.end === h.end_date
             && j.market === h.market && j.status === h.status),
    )

    const gps = gpsMap.get(h.truck_number)
    const chain = checkChainFeasibility({
      campaignStart: h.start_date,
      campaignEnd: h.end_date,
      campaignCoords,
      jobs,
      currentCoords: gps?.latitude && gps?.longitude ? { lat: gps.latitude, lng: gps.longitude } : null,
      today,
    })

    checked++
    if (!chain.feasible) {
      infeasible.push({
        holdId: h.id,
        truckNumber: h.truck_number,
        clientName: h.client_name,
        market: h.market,
        startDate: h.start_date,
        endDate: h.end_date,
        status: h.status,
        origination: h.origination,
        reason: chain.blockedBy ?? 'CANNOT_ARRIVE',
        detail: chain.detail ?? '',
        overridable: chain.overridable,
      })
    }
  }

  return { checked, infeasible, unresolvedMarkets }
}

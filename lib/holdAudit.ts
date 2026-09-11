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

import { resolveCampaignCoords } from '@/lib/pricing/resolvers'
import { loadFleetTimelines } from '@/lib/fleetTimelines'
import { checkChainFeasibility } from '@/lib/chainFeasibility'
import type { TruckJob } from '@/lib/truckTimeline'

export type InfeasibleHold = {
  holdId: string
  truckNumber: string
  clientName: string
  market: string
  startDate: string
  endDate: string
  status: string
  origination: string
  /** SFDC / CLIENT / INTERNAL — tells a mirror-path artifact from a real bug. */
  source: string
  reason: string
  detail: string
  /** True when the blocker is a soft hold — resolvable without moving this booking. */
  overridable: boolean
}

export type HoldAuditResult = {
  checked: number
  infeasible: InfeasibleHold[]
  /** Holds skipped because their own market could not be geocoded. */
  unresolvedMarkets: { holdId: string; market: string }[]
  /**
   * Holds whose PRIOR job market could not be geocoded, so distance fell back
   * to live GPS. These are priced on the old, wrong basis — a data problem, not
   * a scheduling one.
   */
  gpsFallbacks: { holdId: string; priorMarket: string }[]
}

/**
 * Re-evaluate every active hold whose campaign has not already ended.
 * Each hold is checked against its truck's other jobs, excluding itself.
 */
export async function auditHoldFeasibility(): Promise<HoldAuditResult> {
  const today = new Date().toISOString().split('T')[0]
  const { timelines, gpsMap, holds } = await loadFleetTimelines()

  const coordCache = new Map<string, Awaited<ReturnType<typeof resolveCampaignCoords>>>()
  async function coordsFor(market: string) {
    if (!coordCache.has(market)) coordCache.set(market, await resolveCampaignCoords(market))
    return coordCache.get(market)!
  }

  const infeasible: InfeasibleHold[] = []
  const unresolvedMarkets: { holdId: string; market: string }[] = []
  const gpsFallbacks: { holdId: string; priorMarket: string }[] = []
  let checked = 0

  for (const h of holds) {
    if (!h.start_date || !h.end_date) continue
    if (h.end_date < today) continue // already in the past — nothing to fix

    const campaignCoords = await coordsFor(h.market)
    if (!campaignCoords) {
      unresolvedMarkets.push({ holdId: h.id, market: h.market })
      continue
    }

    // The hold under test must not appear in its own chain.
    const jobs: TruckJob[] = (timelines.get(h.truck_number) ?? []).filter(
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

    if (chain.inbound.originFellBackToGps) {
      gpsFallbacks.push({ holdId: h.id, priorMarket: chain.inbound.originFellBackToGps })
    }

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
        source: h.source,
        reason: chain.blockedBy ?? 'CANNOT_ARRIVE',
        detail: chain.detail ?? '',
        overridable: chain.overridable,
      })
    }
  }

  return { checked, infeasible, unresolvedMarkets, gpsFallbacks }
}

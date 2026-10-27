/**
 * A won reservation follows the truck LED scheduled it on.
 *
 * Ops schedules a won job in LED, and may put it on a different truck than
 * the app held (Andrew, Oct 2026: the reservation follows LED's choice and
 * stays in sync, even when that raises new conflicts, so they're visible).
 * The link is the job number (lib/jobNumber.ts linkedJob), so only committed
 * holds with one ever move.
 *
 * A hold moves only when the answer is unambiguous:
 * - LED runs none of its days on the hold's own truck (within its dates),
 * - LED runs its job, within its dates and in its market, on exactly one
 *   other truck, on at least as many days as were sold (lib/ledJobs.ts
 *   daysSold): a stand-in for a day or two doesn't free the held truck,
 * - no other hold of that job, and no other live hold of the same
 *   opportunity, is on that truck over the same days, and no other hold of
 *   the job could equally be moved to it.
 * Every market of a booking shares its job number (and job numbers are reused
 * across opportunities), so the market has to match (lib/ledJobs.ts
 * ledMarketMatches). A Salesforce multi-market hold ("Multi-market: Detroit,
 * Los Angeles, CA") has no one market: LED's city must be one its label
 * names. Anything else (LED splitting the hold across trucks, only part of it
 * scheduled, two holds that could each take the same truck) is left alone:
 * the hold keeps its truck and Reservations keeps showing the shortfall.
 */

import { prisma } from '@/lib/prisma'
import { jobKey } from '@/lib/jobNumber'
import { ledMarketMatches } from '@/lib/ledJobs'
import { stateCode } from '@/lib/usStates'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'

/** A won hold as following needs it. Dates YYYY-MM-DD, inclusive. `job_number`: its linked job (linkedJob). */
export type FollowHold = {
  id: string; truck_number: string; start_date: string; end_date: string
  market: string; state: string | null; job_number: string | null
  /** The days LED must run it on a truck (lib/ledJobs.ts daysSold). */
  days_sold: number
  sfdc_opportunity_id?: string | null
}

/** Any live hold (any status), for the trucks a booking already occupies. */
export type LiveHold = { id: string; truck_number: string; start_date: string; end_date: string; sfdc_opportunity_id?: string | null }

/** One LED schedule row: a job on a truck on a day, in a market. */
export type FollowRow = {
  truck_number: string; job_number?: string; shift_start: string
  market: string; state?: string; standard_market_name?: string
}

/** A hold to move from its truck to the one LED runs its job on. */
export type TruckMove = { holdId: string; from: string; to: string; job: string }

const MULTI_MARKET = /^\s*multi-market\s*:/i
const cityOf = (m: string) => m.split(',')[0].trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Whether LED's row is in the hold's market. A multi-market label names its
 * cities, so LED's city (its own or its standard market's) must be one of
 * them; any other hold is compared as one market (ledMarketMatches).
 */
function inHoldMarket(h: FollowHold, r: FollowRow): boolean {
  if (MULTI_MARKET.test(h.market)) {
    const named = h.market.replace(MULTI_MARKET, '').split(',').map(c => c.trim().toLowerCase().replace(/\s+/g, ' ')).filter(c => c && !stateCode(c))
    return [cityOf(r.market), cityOf(r.standard_market_name ?? '')].some(c => !!c && named.includes(c))
  }
  return ledMarketMatches({ market: h.market, state: h.state ?? '' }, { market: r.market, state: r.state ?? '', standard_market_name: r.standard_market_name })
}

/**
 * The holds to move, and where. Only holds still running (ending today or
 * later) move; a finished booking keeps the truck it was recorded on. Pure.
 */
export function ledTruckMoves(holds: FollowHold[], rows: FollowRow[], today: string, live: LiveHold[] = []): TruckMove[] {
  const byJob = new Map<string, FollowHold[]>()
  for (const h of holds) {
    const job = jobKey(h.job_number)
    if (!job) continue
    const group = byJob.get(job)
    if (group) group.push(h)
    else byJob.set(job, [h])
  }
  const rowsByJob = new Map<string, FollowRow[]>()
  for (const r of rows) {
    const job = jobKey(r.job_number)
    if (!job || !byJob.has(job)) continue
    const group = rowsByJob.get(job)
    if (group) group.push(r)
    else rowsByJob.set(job, [r])
  }

  const moves: TruckMove[] = []
  for (const [job, group] of byJob) {
    const jobRows = rowsByJob.get(job) ?? []
    if (!jobRows.length) continue
    // Trucks a hold of this job is already on over the same days: LED running
    // the job there is that hold's, never another's to move onto. Dates
    // matter: one truck can carry two markets of a booking one after another.
    const overlaps = (a: FollowHold, b: FollowHold) => a.start_date <= b.end_date && b.start_date <= a.end_date
    const within = (h: FollowHold) => jobRows.filter(r => r.shift_start >= h.start_date && r.shift_start <= h.end_date)
    // Each hold LED isn't running on its own truck, with every other truck it could be on.
    // Another live hold of the same opportunity (a market not yet won, say) on that truck over the same days.
    const takenByBooking = (h: FollowHold, truck: string) => !!h.sfdc_opportunity_id && live.some(o =>
      o.id !== h.id && o.sfdc_opportunity_id === h.sfdc_opportunity_id && o.truck_number === truck && o.start_date <= h.end_date && h.start_date <= o.end_date)
    // LED days of the job on a truck within the hold's dates.
    const daysOn = (h: FollowHold, truck: string) =>
      new Set(within(h).filter(r => r.truck_number === truck).map(r => r.shift_start)).size
    const unmatched = group
      .filter(h => h.end_date >= today && h.days_sold > 0)
      .map(h => ({ hold: h, rows: within(h) }))
      .filter(u => !u.rows.some(r => r.truck_number === u.hold.truck_number))
      .map(({ hold: h, rows: inDates }) => ({
        hold: h,
        candidates: [...new Set(inDates
          .filter(r => !group.some(o => o !== h && o.truck_number === r.truck_number && overlaps(o, h)))
          .filter(r => !takenByBooking(h, r.truck_number))
          .filter(r => inHoldMarket(h, r))
          .map(r => r.truck_number))],
      }))
    for (const u of unmatched) {
      if (u.candidates.length !== 1) continue
      const to = u.candidates[0]
      // Only once LED runs it there for every day sold.
      if (daysOn(u.hold, to) < u.hold.days_sold) continue
      // Another hold of the job, over the same days, that could take the same
      // truck: which one LED meant can't be told, so neither moves.
      if (unmatched.some(o => o !== u && overlaps(o.hold, u.hold) && o.candidates.includes(to))) continue
      moves.push({ holdId: u.hold.id, from: u.hold.truck_number, to, job })
    }
  }
  return moves
}

/**
 * Moves each hold ledTruckMoves names onto LED's truck, as a truck swap made
 * by the sweep: audited (SWAP_HOLD_TRUCK, reason led_truck_follow) in the same
 * transaction as the move. Returns the moves made, the opportunities whose LED
 * Trucks the caller syncs to Salesforce (the app owns them), and the user the
 * swaps are recorded as. The caller measures the swaps (recordSwap) after
 * conflict detection, so the fleet and GPS loads never delay it.
 *
 * MIRROR PATH — no clash check by design. LED has the job on that truck
 * already; refusing would leave the app holding a truck LED isn't using and
 * hide the real clash. Another booking on the new truck surfaces as a
 * conflict and on /api/holds/infeasible.
 * Each write is guarded on the hold still being committed on its old truck,
 * so a swap or un-commit made meanwhile wins. One failed move never stops the
 * rest.
 */
export async function followLedTrucks(
  holds: (FollowHold & { sfdc_opportunity_id: string | null; created_by: string })[],
  rows: FollowRow[],
  today: string,
  live: LiveHold[],
): Promise<{ moved: TruckMove[]; opportunities: string[]; serviceUserId: string | null }> {
  const moves = ledTruckMoves(holds, rows, today, live)
  if (!moves.length) return { moved: [], opportunities: [], serviceUserId: null }
  const serviceUser = await prisma.user.findUnique({ where: { email: SFDC_SERVICE_USER_EMAIL }, select: { id: true } })
  const byId = new Map(holds.map(h => [h.id, h]))
  const moved: TruckMove[] = []
  const opportunities = new Set<string>()
  for (const m of moves) {
    const hold = byId.get(m.holdId)
    if (!hold) continue
    try {
      // Move and audit together: a move left without its audit row (or
      // reported as failed after it was written) would never reach
      // Salesforce's LED Trucks, and the next sweep sees nothing to move.
      const done = await prisma.$transaction(async (tx) => {
        const { count } = await tx.hold.updateMany({
          where: { id: m.holdId, truck_number: m.from, status: 'COMMITTED' },
          data:  { truck_number: m.to },
        })
        if (!count) return false
        await tx.auditLog.create({
          data: {
            action:       'SWAP_HOLD_TRUCK',
            truck_number: m.to,
            user_id:      serviceUser?.id ?? hold.created_by,
            hold_id:      m.holdId,
            details:      JSON.stringify({ old_truck: m.from, new_truck: m.to, reason: 'led_truck_follow', job_number: m.job }),
          },
        })
        return true
      })
      if (!done) continue
      moved.push(m)
      if (hold.sfdc_opportunity_id) opportunities.add(hold.sfdc_opportunity_id)
      console.log(`[led-follow] hold ${m.holdId} (job ${m.job}) moved from truck ${m.from} to ${m.to}, where LED runs it`)
    } catch (err) {
      console.error(`[led-follow] moving hold ${m.holdId} to truck ${m.to} failed; carrying on:`, err)
    }
  }
  return { moved, opportunities: [...opportunities], serviceUserId: serviceUser?.id ?? null }
}

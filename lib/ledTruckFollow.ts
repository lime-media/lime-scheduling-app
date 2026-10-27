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
 * - LED runs none of its days on the hold's own truck (within its dates), and
 * - LED runs its job, within its dates and in its market, on exactly one
 *   other truck, which no other hold of that job is on, and which no other
 *   hold of that job could equally be moved to.
 * Every market of a booking shares its job number (and job numbers are reused
 * across opportunities), so the market has to match (lib/ledJobs.ts
 * ledMarketMatches). A hold whose market can't be read (a Salesforce
 * multi-market hold carries no state) moves only when that one truck is the
 * only place it can go. Anything else (LED splitting the hold across trucks,
 * two holds that could each take the same truck) is left alone: the hold
 * keeps its truck and Reservations keeps showing the shortfall.
 */

import { prisma } from '@/lib/prisma'
import { jobKey } from '@/lib/jobNumber'
import { ledMarketMatches } from '@/lib/ledJobs'
import { stateCode } from '@/lib/usStates'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'
import { recordSwap } from '@/lib/transportMetricsRecord'

/** A won hold as following needs it. Dates YYYY-MM-DD, inclusive. `job_number`: its linked job (linkedJob). */
export type FollowHold = {
  id: string; truck_number: string; start_date: string; end_date: string
  market: string; state: string | null; job_number: string | null
}

/** One LED schedule row: a job on a truck on a day, in a market. */
export type FollowRow = {
  truck_number: string; job_number?: string; shift_start: string
  market: string; state?: string; standard_market_name?: string
}

/** A hold to move from its truck to the one LED runs its job on. */
export type TruckMove = { holdId: string; from: string; to: string; job: string }

/** Whether the hold's market can be read well enough to compare (a state, from its field or "City, ST"). */
const marketReadable = (h: FollowHold) => !!(stateCode(h.state) || stateCode(h.market.split(',')[1]))

/**
 * The holds to move, and where. Only holds still running (ending today or
 * later) move; a finished booking keeps the truck it was recorded on. Pure.
 */
export function ledTruckMoves(holds: FollowHold[], rows: FollowRow[], today: string): TruckMove[] {
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
    // Trucks a hold of this job is already on: LED running the job there is
    // that hold's, never another's to move onto.
    const claimed = new Set(group.map(h => h.truck_number))
    const within = (h: FollowHold) => jobRows.filter(r => r.shift_start >= h.start_date && r.shift_start <= h.end_date)
    // Each hold LED isn't running on its own truck, with every other truck it could be on.
    const unmatched = group
      .filter(h => h.end_date >= today && !within(h).some(r => r.truck_number === h.truck_number))
      .map(h => ({
        hold: h,
        candidates: [...new Set(within(h)
          .filter(r => !claimed.has(r.truck_number))
          .filter(r => !marketReadable(h) || ledMarketMatches(
            { market: h.market, state: h.state ?? '' },
            { market: r.market, state: r.state ?? '', standard_market_name: r.standard_market_name },
          ))
          .map(r => r.truck_number))],
      }))
    for (const u of unmatched) {
      if (u.candidates.length !== 1) continue
      const to = u.candidates[0]
      // Another hold of the job that could take the same truck: which one LED
      // meant can't be told, so neither moves.
      if (unmatched.some(o => o !== u && o.candidates.includes(to))) continue
      moves.push({ holdId: u.hold.id, from: u.hold.truck_number, to, job })
    }
  }
  return moves
}

/**
 * Moves each hold ledTruckMoves names onto LED's truck, as a truck swap made
 * by the sweep: audited (SWAP_HOLD_TRUCK, reason led_truck_follow) and
 * measured like a manual swap. Returns the moves made and the opportunities
 * whose LED Trucks the caller syncs to Salesforce (the app owns them).
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
): Promise<{ moved: TruckMove[]; opportunities: string[] }> {
  const moves = ledTruckMoves(holds, rows, today)
  if (!moves.length) return { moved: [], opportunities: [] }
  const serviceUser = await prisma.user.findUnique({ where: { email: SFDC_SERVICE_USER_EMAIL }, select: { id: true } })
  const byId = new Map(holds.map(h => [h.id, h]))
  const moved: TruckMove[] = []
  const opportunities = new Set<string>()
  for (const m of moves) {
    const hold = byId.get(m.holdId)
    if (!hold) continue
    try {
      const { count } = await prisma.hold.updateMany({
        where: { id: m.holdId, truck_number: m.from, status: 'COMMITTED' },
        data:  { truck_number: m.to },
      })
      if (!count) continue
      await prisma.auditLog.create({
        data: {
          action:       'SWAP_HOLD_TRUCK',
          truck_number: m.to,
          user_id:      serviceUser?.id ?? hold.created_by,
          hold_id:      m.holdId,
          details:      JSON.stringify({ old_truck: m.from, new_truck: m.to, reason: 'led_truck_follow', job_number: m.job }),
        },
      })
      await recordSwap(m.holdId, serviceUser?.id ?? null)
      moved.push(m)
      if (hold.sfdc_opportunity_id) opportunities.add(hold.sfdc_opportunity_id)
      console.log(`[led-follow] hold ${m.holdId} (job ${m.job}) moved from truck ${m.from} to ${m.to}, where LED runs it`)
    } catch (err) {
      console.error(`[led-follow] moving hold ${m.holdId} to truck ${m.to} failed; carrying on:`, err)
    }
  }
  return { moved, opportunities: [...opportunities] }
}

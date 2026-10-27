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
import { syncOpportunityLedWindow } from '@/lib/sfdcBooking'

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

/** The dates LED's rows cover (YYYY-MM-DD, inclusive): a hold reaching outside them can't be judged. */
export type SeenWindow = { from: string; to: string }

const MULTI_MARKET = /^\s*multi-market\s*:/i
const cityOf = (m: string) => m.split(',')[0].trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Whether LED's row is in the hold's market. A multi-market label names its
 * cities, so LED's city (its own or its standard market's) must be one of
 * them; any other hold is compared as one market (ledMarketMatches). Only a
 * two-letter token is dropped as a state: "New York" and "Washington" are
 * cities in a label, though stateCode reads them as states.
 */
function inHoldMarket(h: FollowHold, r: FollowRow): boolean {
  if (MULTI_MARKET.test(h.market)) {
    const named = h.market.replace(MULTI_MARKET, '').split(',').map(cityOf).filter(c => c && !(c.length === 2 && stateCode(c)))
    return [cityOf(r.market), cityOf(r.standard_market_name ?? '')].some(c => !!c && named.includes(c))
  }
  return ledMarketMatches({ market: h.market, state: h.state ?? '' }, { market: r.market, state: r.state ?? '', standard_market_name: r.standard_market_name })
}

/**
 * The holds to move, and where. Only holds still running (ending today or
 * later) move; a finished booking keeps the truck it was recorded on. With
 * `seen`, only holds wholly inside the dates LED's rows cover move: a day of
 * the hold's own truck outside them can't be seen, so a split could look like
 * a move. Pure.
 */
export function ledTruckMoves(holds: FollowHold[], rows: FollowRow[], today: string, live: LiveHold[] = [], seen?: SeenWindow): TruckMove[] {
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
    // Another live hold of the same opportunity (a market not yet won, say) on that truck over the same days.
    const takenByBooking = (h: FollowHold, truck: string) => !!h.sfdc_opportunity_id && live.some(o =>
      o.id !== h.id && o.sfdc_opportunity_id === h.sfdc_opportunity_id && o.truck_number === truck && o.start_date <= h.end_date && h.start_date <= o.end_date)
    // LED days of the job on a truck within the hold's dates and in its market
    // (another market of a reused job number on that truck isn't this hold's).
    const daysOn = (h: FollowHold, truck: string) =>
      new Set(within(h).filter(r => r.truck_number === truck && inHoldMarket(h, r)).map(r => r.shift_start)).size
    // Each hold LED isn't running on its own truck, with every other truck it could be on.
    const unmatched = group
      .filter(h => h.end_date >= today && h.days_sold > 0)
      .filter(h => !seen || (h.start_date >= seen.from && h.end_date <= seen.to))
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
 * transaction as the move. Returns the moves made, each with the user it is
 * recorded as, and the opportunities whose LED Trucks the caller syncs to
 * Salesforce (the app owns them). The caller measures the swaps (recordSwap) after
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
  seen?: SeenWindow,
): Promise<{ moved: (TruckMove & { by: string })[]; opportunities: string[] }> {
  const moves = ledTruckMoves(holds, rows, today, live, seen)
  if (!moves.length) return { moved: [], opportunities: [] }
  const serviceUser = await prisma.user.findUnique({ where: { email: SFDC_SERVICE_USER_EMAIL }, select: { id: true } })
  const byId = new Map(holds.map(h => [h.id, h]))
  const moved: (TruckMove & { by: string })[] = []
  const opportunities = new Set<string>()
  for (const m of moves) {
    const hold = byId.get(m.holdId)
    if (!hold) continue
    const by = serviceUser?.id ?? hold.created_by
    try {
      // Move and audit together: a move left without its audit row (or
      // reported as failed after it was written) would never reach
      // Salesforce's LED Trucks, and the next sweep sees nothing to move.
      const done = await prisma.$transaction(async (tx) => {
        const { count } = await tx.hold.updateMany({
          where: { id: m.holdId, truck_number: m.from, status: 'COMMITTED' },
          // Marked until its opportunity's LED Trucks reaches Salesforce
          // (syncFollowedOpportunities): once the hold is on LED's truck the
          // next sweep has nothing to move, so the mark is what retries the sync.
          data:  { truck_number: m.to, ...(hold.sfdc_opportunity_id ? { led_follow_sync_pending: new Date() } : {}) },
        })
        if (!count) return false
        await tx.auditLog.create({
          data: {
            action:       'SWAP_HOLD_TRUCK',
            truck_number: m.to,
            user_id:      by,
            hold_id:      m.holdId,
            details:      JSON.stringify({ old_truck: m.from, new_truck: m.to, reason: 'led_truck_follow', job_number: m.job }),
          },
        })
        return true
      })
      if (!done) continue
      moved.push({ ...m, by })
      if (hold.sfdc_opportunity_id) opportunities.add(hold.sfdc_opportunity_id)
      console.log(`[led-follow] hold ${m.holdId} (job ${m.job}) moved from truck ${m.from} to ${m.to}, where LED runs it`)
    } catch (err) {
      console.error(`[led-follow] moving hold ${m.holdId} to truck ${m.to} failed; carrying on:`, err)
    }
  }
  return { moved, opportunities: [...opportunities] }
}

/** How long a refused LED Trucks sync is retried before it's left to staff (logged as an error). */
const FOLLOW_SYNC_RETRY_DAYS = 7

/**
 * Syncs LED Trucks to Salesforce for the opportunities of holds moved this
 * sweep, and of committed holds moved earlier whose sync hasn't succeeded yet
 * (led_follow_sync_pending), and clears the mark once Salesforce has taken
 * it. A failure stays marked and is retried next sweep, for up to
 * FOLLOW_SYNC_RETRY_DAYS: an opportunity Salesforce refuses for good (deleted,
 * a validation rule) is then logged as an error and left. A hold no longer
 * committed isn't retried here: every release path syncs on its own.
 * Clearing only touches the marks read just before the sync ran, unchanged,
 * so a move made meanwhile stays marked. Returns the opportunities still waiting. Never throws.
 */
export async function syncFollowedOpportunities(justMoved: string[]): Promise<string[]> {
  const now = new Date()
  const cutoff = new Date(now.getTime() - FOLLOW_SYNC_RETRY_DAYS * 864e5)
  const marked = await prisma.hold.findMany({
    where:  { led_follow_sync_pending: { not: null }, status: 'COMMITTED', sfdc_opportunity_id: { not: null } },
    select: { id: true, sfdc_opportunity_id: true, led_follow_sync_pending: true },
  }).catch((err) => {
    console.error('[led-follow] reading holds waiting for a Salesforce sync failed:', err)
    return []
  })
  // A hold no longer committed drops its mark: its release synced on its own,
  // and a mark left behind would be taken for a refused sync if it's won again.
  await prisma.hold.updateMany({ where: { led_follow_sync_pending: { not: null }, status: { not: 'COMMITTED' } }, data: { led_follow_sync_pending: null } })
    .catch((err) => console.error('[led-follow] clearing sync marks on holds no longer committed failed:', err))
  const stale = marked.filter(h => h.led_follow_sync_pending && h.led_follow_sync_pending < cutoff)
  const retry = marked.filter(h => !stale.includes(h)).map(h => h.sfdc_opportunity_id).filter((id): id is string => !!id)
  if (stale.length) {
    // An opportunity another of its holds still retries isn't given up on.
    const givenUp = [...new Set(stale.map(h => h.sfdc_opportunity_id))].filter(id => id && !retry.includes(id) && !justMoved.includes(id))
    if (givenUp.length) console.error(`[led-follow] LED Trucks never reached Salesforce after ${FOLLOW_SYNC_RETRY_DAYS} days; set it by hand on: ${givenUp.join(', ')}`)
    await prisma.hold.updateMany({ where: { id: { in: stale.map(h => h.id) } }, data: { led_follow_sync_pending: null } })
      .catch((err) => console.error('[led-follow] clearing expired sync marks failed:', err))
  }
  const pending: string[] = []
  for (const opp of new Set([...justMoved, ...retry])) {
    // The marks this sync covers: read before it runs, and cleared only if
    // unchanged after, so a move committed meanwhile (another sweep's) keeps
    // its mark for the next sweep.
    const covered = await prisma.hold.findMany({
      where:  { sfdc_opportunity_id: opp, led_follow_sync_pending: { not: null } },
      select: { id: true, led_follow_sync_pending: true },
    }).catch(() => [])
    const warning = await syncOpportunityLedWindow(opp)
    if (warning) {
      console.warn(`[led-follow] ${opp}: ${warning} Retrying next sweep.`)
      pending.push(opp)
      continue
    }
    for (const h of covered) {
      await prisma.hold.updateMany({ where: { id: h.id, led_follow_sync_pending: h.led_follow_sync_pending }, data: { led_follow_sync_pending: null } })
        .catch((err) => console.error(`[led-follow] clearing the sync mark on hold ${h.id} failed:`, err))
    }
  }
  return pending
}

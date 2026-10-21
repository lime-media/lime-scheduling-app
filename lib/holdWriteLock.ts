/**
 * Writing holds without double-booking.
 *
 * Every booking path checks for clashes when it picks trucks, then writes the
 * holds a moment later (after pricing, Salesforce lookups, or a model turn in
 * the AI chat). Two bookings in that window could both pass the check and both
 * write, selling a truck twice. writeHoldsExclusive closes the window: inside
 * one transaction it takes an exclusive lock on each truck (SQL Server
 * sp_getapplock, released when the transaction ends), checks again that no
 * other live hold overlaps the dates, and only then runs the write. A second
 * booking of the same truck waits for the first to commit, then sees its hold.
 *
 * For the paths that choose trucks (Quote page, planner, client portal, AI
 * chat, MCP, grid holds, swaps, edits, reinstate). Mirror paths (the
 * Salesforce hold webhook, the AT&T sync) record what exists elsewhere and
 * never refuse, so they don't use it (REVIEW.md "Mirror paths record").
 * Server only.
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere } from '@/lib/holdFilters'

/** One truck over a date range (YYYY-MM-DD, inclusive), as a hold would book it. */
export type HoldSpan = { truck: string; start: string; end: string }

export type HoldClashRow = { truck: string; start: string; end: string; client: string; status: string }

/** Thrown when a truck was booked by someone else since it was chosen. Nothing was written. */
export class HoldClashError extends Error {
  constructor(public readonly clashes: HoldClashRow[]) {
    const trucks = [...new Set(clashes.map(c => c.truck))]
    super(`${trucks.map(t => `Truck ${t}`).join(', ')} ${trucks.length === 1 ? 'is' : 'are'} already booked for these dates.`)
    this.name = 'HoldClashError'
  }
}

/** Thrown when another booking of the same truck held its lock too long. Nothing was written; trying again works. */
export class HoldLockTimeoutError extends Error {
  constructor(truck: string) {
    super(`Another booking of truck ${truck} is being saved right now. Try again in a moment.`)
    this.name = 'HoldLockTimeoutError'
  }
}

/**
 * How long a booking waits, in all, for other bookings of its trucks to
 * finish. One budget across every truck's lock, so a many-truck booking can't
 * outwait the transaction's own timeout below.
 */
const LOCK_TIMEOUT_MS = 15_000
/** Time left for the re-check and the write once the locks are held. */
const WRITE_TIMEOUT_MS = 30_000

const day = (d: Date) => d.toISOString().slice(0, 10)

/**
 * The live holds (other than `ignore`) that overlap any span on its truck.
 * Pure over the rows passed in; exported for tests.
 */
export function clashesWith(spans: HoldSpan[], holds: { id: string; truck_number: string; start_date: Date; end_date: Date; client_name: string; status: string }[], ignore: Set<string>): HoldClashRow[] {
  return holds
    .filter(h => !ignore.has(h.id) && spans.some(s => s.truck === h.truck_number && day(h.start_date) <= s.end && day(h.end_date) >= s.start))
    .map(h => ({ truck: h.truck_number, start: day(h.start_date), end: day(h.end_date), client: h.client_name, status: h.status }))
}

/**
 * Run `write` with each span's truck locked and no other live hold on its
 * dates; throws HoldClashError (and writes nothing) if one is. `ignoreHoldIds`
 * are holds this write replaces or moves (a revision's old holds, the hold
 * being edited, swapped or reinstated), which mustn't count against it.
 * `excludeAttSoft` matches a caller whose own conflict check ignores AT&T
 * soft holds (the planner), so the re-check refuses only what it would.
 * Spans with no truck to reserve (quote-only logs) should not be passed.
 */
export async function writeHoldsExclusive<T>(
  spans: HoldSpan[],
  write: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: { ignoreHoldIds?: string[]; excludeAttSoft?: boolean } = {},
): Promise<T> {
  const trucks = [...new Set(spans.map(s => s.truck))].sort()
  const ignore = new Set(opts.ignoreHoldIds ?? [])
  return prisma.$transaction(async tx => {
    // Sorted, so two bookings sharing trucks take the locks in the same order
    // and can't deadlock.
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    for (const truck of trucks) {
      const wait = Math.max(0, deadline - Date.now())
      const [lock] = await tx.$queryRaw<{ r: number }[]>`
        DECLARE @r int;
        EXEC @r = sp_getapplock @Resource = ${`hold-truck:${truck}`}, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = ${wait};
        SELECT @r AS r;`
      if (!lock || lock.r < 0) throw new HoldLockTimeoutError(truck)
    }
    if (spans.length) {
      const from = spans.map(s => s.start).sort()[0]
      const to = spans.map(s => s.end).sort().reverse()[0]
      const live = await tx.hold.findMany({
        where: {
          truck_number: { in: trucks },
          // The caller's own conflict rule: the planner books over AT&T soft
          // holds' trucks by its reservation rules, so it doesn't count them.
          ...activeHoldWhere({ excludeAttSoft: opts.excludeAttSoft }),
          start_date: { lte: new Date(to) },
          end_date: { gte: new Date(from) },
        },
        select: { id: true, truck_number: true, start_date: true, end_date: true, client_name: true, status: true },
      })
      const clashes = clashesWith(spans, live, ignore)
      if (clashes.length) throw new HoldClashError(clashes)
    }
    return write(tx)
  }, { maxWait: 10_000, timeout: LOCK_TIMEOUT_MS + WRITE_TIMEOUT_MS })
}

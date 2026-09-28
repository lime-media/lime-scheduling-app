/**
 * Releasing an AT&T soft hold for a specific booking.
 *
 * Anyone signed in may do it, from the place they are booking (the quote, a
 * client request, the schedule grid, the Conflicts page), after a warning to
 * check with operations. It releases ONLY the booking's dates, at most
 * ATT_RELEASE_MAX_DAYS at a time: the soft hold is cut around them, so the
 * rest stays reserved for AT&T.
 *
 * It sticks. Every release writes a release record (status EXPIRED,
 * origination 'att_soft_release') for the dates — even when no soft hold
 * exists there yet (a booking beyond the sync's window), so the soft hold is
 * never created over it later. EXPIRED rows block nothing anywhere; the
 * hourly sync never re-creates a soft hold over a release record, and cuts
 * any soft hold that ends up over one (a release that landed mid-sync).
 *
 * It can be undone (undoRelease), which removes the record so the next sync
 * reserves those dates for AT&T again.
 *
 * The partner/MCP API and the client portal can never do this.
 */

import { prisma } from '@/lib/prisma'
import { ATT_RELEASE_ORIGINATION, ATT_RELEASE_WARNING, ATT_RELEASE_MAX_DAYS, carve, validateReleaseRange } from '@/lib/attSoftRules'

export { ATT_RELEASE_ORIGINATION, ATT_RELEASE_WARNING, ATT_RELEASE_MAX_DAYS, carve }

const iso = (d: Date) => d.toISOString().slice(0, 10)
const utc = (s: string) => new Date(s + 'T00:00:00Z')

export type ReleaseResult = {
  /** The dates released (the requested range, recorded). */
  released: { start: string; end: string }
  /** Soft-hold date ranges actually cut for this release. */
  cut: { start: string; end: string }[]
  /** Soft-hold pieces left in place around the booking. */
  kept: { start: string; end: string }[]
  /** The release record's id (for undo). */
  releaseId: string
}

/** A refusal the person can act on (bad dates, too long, lost a race). */
export class ReleaseError extends Error {}

/**
 * Release a truck's AT&T soft hold for [start, end] — the dates of the
 * booking that needs the truck. One transaction; retried once if a
 * concurrent release changed the soft holds under it.
 */
export async function releaseAttSoftForBooking(opts: {
  truckNumber: string
  start: string
  end: string
  userId: string
  userName?: string | null
  /** What the release is for, e.g. "Quote: Acme, Dallas" or "Client request 123". */
  context: string
}): Promise<ReleaseResult> {
  const { truckNumber, start, end, userId, context } = opts
  const invalid = validateReleaseRange(start, end)
  if (invalid) throw new ReleaseError(invalid)

  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await prisma.$transaction(async tx => {
      // Read inside the transaction, so what is cut is what is there now.
      const soft = await tx.hold.findMany({
        where: { truck_number: truckNumber, status: 'ATT_SOFT', start_date: { lte: utc(end) }, end_date: { gte: utc(start) } },
      })
      const cut: ReleaseResult['cut'] = []
      const kept: ReleaseResult['kept'] = []
      const replaced: string[] = []
      const createdIds: string[] = []
      for (const h of soft) {
        const hs = iso(h.start_date), he = iso(h.end_date)
        // Only if it is still a soft hold: a concurrent release may have cut
        // it. Then start over on fresh data rather than report a wrong result.
        const { count } = await tx.hold.deleteMany({ where: { id: h.id, status: 'ATT_SOFT' } })
        if (count === 0) throw new RaceLost()
        replaced.push(h.id)
        for (const p of carve(hs, he, start, end)) {
          const piece = await tx.hold.create({
            data: {
              truck_number: h.truck_number, status: 'ATT_SOFT', client_name: h.client_name,
              market: h.market, state: h.state, notes: h.notes,
              start_date: utc(p.start), end_date: utc(p.end), created_by: h.created_by,
            },
          })
          createdIds.push(piece.id)
          kept.push(p)
        }
        cut.push({ start: start > hs ? start : hs, end: end < he ? end : he })
      }
      // The release record, for the whole booking range: blocks nothing
      // (EXPIRED), and keeps the sync from ever putting the soft hold back —
      // including dates the sync has not reached yet.
      const record = await tx.hold.create({
        data: {
          truck_number: truckNumber, status: 'EXPIRED', client_name: 'AT&T',
          market: soft[0]?.market ?? '', state: soft[0]?.state ?? '',
          notes: `AT&T soft hold released for ${context} by ${opts.userName ?? 'a user'}.`,
          start_date: utc(start), end_date: utc(end),
          created_by: userId, source: 'INTERNAL', origination: ATT_RELEASE_ORIGINATION,
          expires_at: new Date(),
        },
      })
      await tx.auditLog.create({
        data: {
          action: 'RELEASE_ATT_SOFT',
          truck_number: truckNumber,
          user_id: userId,
          // Ids in details, not hold_id: Undo deletes the record.
          details: JSON.stringify({ context, release_id: record.id, released: { start, end }, cut, replaced_hold_ids: replaced, created_hold_ids: createdIds, kept }),
        },
      })
      return { released: { start, end }, cut, kept, releaseId: record.id }
    }).catch(err => { if (err instanceof RaceLost) return null; throw err })
    if (outcome) return outcome
  }
  throw new ReleaseError('Someone else changed this soft hold at the same moment. Try again.')
}

class RaceLost extends Error {}

/**
 * Undo a release: remove its record so the next sync reserves those dates for
 * AT&T again (if the truck is still AT&T's and nothing else is booked there).
 */
export async function undoRelease(opts: { releaseId: string; userId: string }): Promise<{ truckNumber: string; start: string; end: string } | null> {
  const rec = await prisma.hold.findFirst({ where: { id: opts.releaseId, origination: ATT_RELEASE_ORIGINATION, status: 'EXPIRED' } })
  if (!rec) return null
  await prisma.$transaction([
    prisma.auditLog.create({
      data: {
        action: 'UNDO_RELEASE_ATT_SOFT', truck_number: rec.truck_number, user_id: opts.userId,
        details: JSON.stringify({ release_id: rec.id, start: iso(rec.start_date), end: iso(rec.end_date), notes: rec.notes }),
      },
    }),
    prisma.hold.deleteMany({ where: { id: rec.id, origination: ATT_RELEASE_ORIGINATION, status: 'EXPIRED' } }),
  ])
  return { truckNumber: rec.truck_number, start: iso(rec.start_date), end: iso(rec.end_date) }
}

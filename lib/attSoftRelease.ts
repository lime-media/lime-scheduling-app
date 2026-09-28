/**
 * Releasing an AT&T soft hold for a specific booking.
 *
 * Anyone signed in may do it, from the place they are booking (the quote, a
 * client request, or the schedule grid), after a warning to check with
 * operations. It releases ONLY the new booking's dates: the soft hold is cut
 * around them, so the rest of the month stays reserved for AT&T.
 *
 * It sticks. The released dates are recorded as a release row (status EXPIRED,
 * origination 'att_soft_release'): EXPIRED rows block nothing anywhere, and
 * the AT&T soft-hold sync treats these dates as already handled, so it never
 * re-creates a soft hold over them.
 *
 * The partner/MCP API can never do this. Soft holds block it outright.
 */

import { prisma } from '@/lib/prisma'

import { ATT_RELEASE_ORIGINATION, ATT_RELEASE_WARNING, carve } from '@/lib/attSoftRules'

export { ATT_RELEASE_ORIGINATION, ATT_RELEASE_WARNING, carve }

const iso = (d: Date) => d.toISOString().slice(0, 10)
const utc = (s: string) => new Date(s + 'T00:00:00Z')

export type ReleaseResult = {
  /** Date ranges released, per soft hold touched. */
  released: { start: string; end: string }[]
  /** Soft-hold pieces left in place around the booking. */
  kept: { start: string; end: string }[]
}

/**
 * Release a truck's AT&T soft hold(s) for [start, end] — the dates of the
 * booking that needs the truck. All in one transaction.
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
    throw new Error('Release dates must be YYYY-MM-DD, end on or after start.')
  }
  const soft = await prisma.hold.findMany({
    where: { truck_number: truckNumber, status: 'ATT_SOFT', start_date: { lte: utc(end) }, end_date: { gte: utc(start) } },
  })
  const released: ReleaseResult['released'] = []
  const kept: ReleaseResult['kept'] = []
  if (soft.length === 0) return { released, kept }

  await prisma.$transaction(async tx => {
    for (const h of soft) {
      const hs = iso(h.start_date), he = iso(h.end_date)
      const rs = start > hs ? start : hs
      const re = end < he ? end : he
      const pieces = carve(hs, he, start, end)
      // Only if it is still a soft hold: someone may have just changed it.
      const { count } = await tx.hold.deleteMany({ where: { id: h.id, status: 'ATT_SOFT' } })
      if (count === 0) continue
      for (const p of pieces) {
        await tx.hold.create({
          data: {
            truck_number: h.truck_number, status: 'ATT_SOFT', client_name: h.client_name,
            market: h.market, state: h.state, notes: h.notes,
            start_date: utc(p.start), end_date: utc(p.end), created_by: h.created_by,
          },
        })
        kept.push(p)
      }
      // The release record: blocks nothing (EXPIRED), and tells the sync these
      // dates were released on purpose so it does not put the soft hold back.
      const marker = await tx.hold.create({
        data: {
          truck_number: h.truck_number, status: 'EXPIRED', client_name: 'AT&T',
          market: h.market, state: h.state,
          notes: `AT&T soft hold released for ${context} by ${opts.userName ?? 'a user'}.`,
          start_date: utc(rs), end_date: utc(re),
          created_by: userId, source: 'INTERNAL', origination: ATT_RELEASE_ORIGINATION,
          expires_at: new Date(),
        },
      })
      await tx.auditLog.create({
        data: {
          action: 'RELEASE_ATT_SOFT',
          truck_number: h.truck_number,
          user_id: userId,
          hold_id: marker.id,
          details: JSON.stringify({ context, released: { start: rs, end: re }, soft_hold: { start: hs, end: he }, kept: pieces }),
        },
      })
      released.push({ start: rs, end: re })
    }
  })
  return { released, kept }
}

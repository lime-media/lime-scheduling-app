/**
 * Setting a booking's one expiry: Reservations → Edit, approving a client's
 * extension request, and the Extend link in the expiry reminder email
 * (app/api/extend). One place, so all of them refuse the same things
 * (lib/expiryRules.ts) and write the same way.
 *
 * A booking is one quote (lib/bookings.ts bookingKey): every live hold of it
 * gets the same date. A hold that lapsed by time but hasn't been swept is
 * brought back under its truck's lock (lib/holdWriteLock.ts). Salesforce's LED Hold Exp and LED Trucks follow
 * (syncOpportunityLedWindow): the app owns them.
 */
import type { Hold, Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { holdReservesNow } from '@/lib/holdFilters'
import { bookingKey, reinstateRefusal } from '@/lib/bookings'
import { loadBookingHolds } from '@/lib/bookingLoad'
import { getOpportunityStage } from '@/lib/sfdcOpportunityReconcile'
import { type ExpiryActor, capStarts, expiryRefusal } from '@/lib/expiryRules'
import { syncOpportunityLedWindow } from '@/lib/sfdcBooking'
import { centralDate, endOfDayCentral } from '@/lib/dateOnly'
import { HoldClashError, HoldLockTimeoutError, writeHoldsExclusive } from '@/lib/holdWriteLock'
import { EXTEND_STALE_MESSAGE } from '@/lib/extendLink'

export type HoldWithClient = Hold & { client_user: { username: string; email: string | null; company_name: string } | null }
type Stage = Awaited<ReturnType<typeof getOpportunityStage>>

const day = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Every hold of the booking this hold belongs to (lib/bookings.ts bookingKey:
 * all markets of a multi-market quote, a campaign group, or a Salesforce
 * opportunity), or the hold alone. A booking is one quote: extensions, cancel
 * and expiry edits act on all of it in one request.
 */
export async function loadBooking(hold: Hold): Promise<HoldWithClient[]> {
  const key = bookingKey(hold)
  const ids = key ? (await loadBookingHolds(key)).map(h => h.id) : []
  if (!ids.includes(hold.id)) ids.push(hold.id)
  return prisma.hold.findMany({
    where:   { id: { in: ids } },
    include: { client_user: { select: { username: true, email: true, company_name: true } } },
  })
}

/** The start dates that cap the booking's one expiry (lib/expiryRules.ts). */
export { capStarts }

/**
 * Runs `write` under the locks of the booking's live holds that lapsed by
 * time but haven't been swept yet: giving them a new expiry brings them back,
 * like reinstate, and their trucks may have been booked since. Re-checked
 * inside the transaction; this booking's own holds don't count.
 */
export function reviveBookingExpiry(live: Hold[], booking: Hold[], write: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  const now = new Date()
  const today = centralDate(now)
  // As reinstate: a market that has already ended reserves nothing ahead.
  const lapsed = live.filter(h => !holdReservesNow(h, now) && day(h.end_date) >= today)
  return writeHoldsExclusive(
    lapsed.map(h => ({ truck: h.truck_number, start: day(h.start_date), end: day(h.end_date) })),
    write,
    // Bringing a lapsed hold back is a new reservation of its truck: AT&T soft
    // holds count, as in reinstate (they're treated as permanent).
    { ignoreHoldIds: booking.map(h => h.id) },
  )
}

export type ExpiryResult = { status: number; body: Record<string, unknown> }

/** The booking's expiry moved between the caller's check and the write (setBookingExpiry `expectExpiresAt`). */
class ExpiryChangedError extends Error {}

/** The refusal for a revival that clashed or timed out; anything else is rethrown. */
export function revivalRefusalBody(err: unknown): ExpiryResult {
  if (err instanceof HoldClashError) {
    const clashes = err.clashes.map(c => ({ truck: c.truck, client: c.client, start: c.start, end: c.end }))
    return { status: 409, body: { error: reinstateRefusal(clashes), clashes } }
  }
  if (err instanceof HoldLockTimeoutError) return { status: 409, body: { error: err.message } }
  throw err
}

/**
 * Sets the booking's one expiry to the end of `date` (YYYY-MM-DD, Central) on
 * every live hold, by the rules in lib/expiryRules.ts for `actor`: staff Edit
 * (the default), staff approving a client's request, or the email link.
 * Approving answers the request: the booking goes back to HOLD with its
 * request cleared. `booking` is passed when the caller already has it. `via` is recorded on the audit rows (e.g. 'expiry_email').
 * `expectExpiresAt` (ISO) refuses, inside the write, if `hold`'s expiry is no
 * longer that: the email link's one extension can't race another click or an
 * edit on Reservations.
 */
export async function setBookingExpiry(args: {
  hold: Hold
  date: string | undefined
  userId: string
  actor?: Exclude<ExpiryActor, 'client_request'>
  booking?: HoldWithClient[]
  via?: string
  expectExpiresAt?: string
}): Promise<ExpiryResult> {
  const { hold, date, userId, via } = args
  const actor = args.actor ?? 'staff_edit'
  if (!date) return { status: 400, body: { error: 'expires_at is required' } }
  if (hold.status !== 'HOLD' && hold.status !== 'EXTENSION_REQUESTED') {
    return { status: 400, body: { error: `Cannot update expiration of a hold with status ${hold.status}` } }
  }

  const booking = args.booking ?? await loadBooking(hold)
  const live = booking.filter(h => h.status === 'HOLD' || h.status === 'EXTENSION_REQUESTED')
  // The booking's own checks first; Salesforce is asked for the stage only when they pass.
  const refusalFor = (stage: Stage) => expiryRefusal({ actor, date, booking, stage })
  const refused = refusalFor(null) ?? (hold.sfdc_opportunity_id ? refusalFor(await getOpportunityStage(hold.sfdc_opportunity_id)) : null)
  if (refused) return { status: refused.status, body: { error: refused.error, ...(refused.lastDate ? { lastDate: refused.lastDate } : {}) } }
  const newExp = endOfDayCentral(date)
  // Approve answers a waiting request; the others only run on a booking with none
  // (expiryRefusal), so a request that arrives meanwhile isn't cleared unanswered.
  const fromStatuses = actor === 'staff_approve' ? ['EXTENSION_REQUESTED', 'HOLD'] : ['HOLD']

  // Every live hold of the booking to the one date.
  let updated = live.length
  try {
    await reviveBookingExpiry(live, booking, async tx => {
      if (args.expectExpiresAt) {
        // Conditional on the expiry the caller checked; the row lock makes a racing write wait and then miss.
        // Still live, too: a hold committed or swept since the caller's read isn't brought back.
        const moved = await tx.hold.updateMany({ where: { id: hold.id, expires_at: new Date(args.expectExpiresAt), status: { in: fromStatuses } }, data: { expires_at: newExp } })
        if (moved.count === 0) throw new ExpiryChangedError()
      }
      // Only rows still in the state checked: one committed (Closed Won) or
      // swept since the read keeps its status and isn't audited as re-dated,
      // and one whose client asked to extend meanwhile is left for staff to answer.
      const stillLive = new Set((await tx.hold.findMany({
        where:  { id: { in: live.map(h => h.id) }, status: { in: fromStatuses } },
        select: { id: true },
      })).map(h => h.id))
      if (stillLive.size === 0) throw new ExpiryChangedError()
      const written = await tx.hold.updateMany({
        where: { id: { in: [...stillLive] }, status: { in: fromStatuses } },
        data:  { expires_at: newExp, status: 'HOLD', extension_until: null, extension_reason: null },
      })
      updated = written.count
      await tx.auditLog.createMany({
        data: live.filter(h => stillLive.has(h.id)).map(h => ({
          action:       actor === 'staff_approve' ? 'APPROVE_HOLD_EXTENSION' : 'UPDATE_HOLD_EXPIRATION',
          truck_number: h.truck_number,
          user_id:      userId,
          hold_id:      h.id,
          details:      JSON.stringify({ new_expires_at: newExp.toISOString(), booking: bookingKey(h), ...(via ? { via } : {}) }),
        })),
      })
    })
  } catch (err) {
    if (err instanceof ExpiryChangedError) {
      return { status: 409, body: { error: actor === 'email' ? EXTEND_STALE_MESSAGE : 'This booking changed while you were saving. Refresh and try again.' } }
    }
    return revivalRefusalBody(err)
  }

  const sfdcWarning = await syncOpportunityLedWindow(hold.sfdc_opportunity_id)
  return { status: 200, body: { ok: true, holds: updated, expires_at: newExp.toISOString(), sfdcWarning } }
}

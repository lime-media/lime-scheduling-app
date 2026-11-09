/**
 * Cancelling a booking: Cancel on Reservations (cancel_notify) and the Cancel
 * link in the expiry reminder email (app/cancel) both come here.
 *
 * A booking is one quote, so cancel releases all of its held reservations
 * (HOLD, EXTENSION_REQUESTED) at once. They are marked EXPIRED, not deleted:
 * the booking stays listed under Expired on Reservations and in the client
 * portal, marked Cancelled with its reason, and Reinstate still works on it.
 * Every release path syncs the opportunity's LED Trucks and Hold Exp to
 * Salesforce (syncOpportunityLedWindow), so the released trucks come off it.
 * A won deal (Closed Won) is refused: it changes in Salesforce first.
 */

import type { Hold } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { bookingKey, bookingSummary, closedWonRefusal } from '@/lib/bookings'
import { loadBooking } from '@/lib/bookingExpiry'
import { getOpportunityStage } from '@/lib/sfdcOpportunityReconcile'
import { syncOpportunityLedWindow } from '@/lib/sfdcBooking'
import { sendCancellationEmail } from '@/lib/email'
import { reply, type CoreResult } from '@/lib/coreResult'
import { cleanCancelReason } from '@/lib/cancelReason'
import { EXTEND_STALE_MESSAGE } from '@/lib/extendLink'

/**
 * Cancels `hold`'s whole booking as `userId`. `via` is recorded in the audit
 * log (reservations, expiry_email). With a reason, the client is emailed it
 * when the booking is theirs. Returns the route's status and body.
 */
export async function cancelBooking(opts: { hold: Hold; userId: string; reason: unknown; via: 'reservations' | 'expiry_email'; expectExpiresAt?: string }): Promise<CoreResult> {
  const { hold, userId, via } = opts
  const reason = cleanCancelReason(opts.reason)
  const booking = await loadBooking(hold)
  const live = booking.filter(h => h.status === 'HOLD' || h.status === 'EXTENSION_REQUESTED')
  if (live.length === 0) return reply({ error: 'This reservation is no longer held, so there is nothing to cancel.' }, { status: 409 })

  // Refuse when any of the booking is committed, or Salesforce already says
  // Closed Won (the reconcile commits it within 15 minutes).
  const stage = hold.sfdc_opportunity_id ? await getOpportunityStage(hold.sfdc_opportunity_id) : null
  const won = closedWonRefusal(booking, stage?.isClosed ? { isWon: stage.isWon } : null)
  if (won) return reply({ error: won }, { status: 409 })

  const now = new Date()
  const ids = live.map(h => h.id)
  const data = { status: 'EXPIRED', expires_at: now, extension_until: null, extension_reason: null, cancelled_at: now, cancel_reason: reason, cancelled_by: userId }
  const taken = await prisma.$transaction(async tx => {
    // The email's link: only the booking it warned about. Conditional on the
    // expiry the caller checked, so an extension (staff, the email's Extend,
    // a client's request) landing since that check makes this miss.
    if (opts.expectExpiresAt) {
      const { count } = await tx.hold.updateMany({
        where: { id: hold.id, expires_at: new Date(opts.expectExpiresAt), status: { in: ['HOLD', 'EXTENSION_REQUESTED'] } },
        data,
      })
      if (count === 0) return null
    }
    // Only what is still held: a hold the sweep expired, or another cancel
    // took, meanwhile is left as it is.
    await tx.hold.updateMany({
      where: { id: { in: ids }, status: { in: ['HOLD', 'EXTENSION_REQUESTED'] } },
      data,
    })
    // Only the holds this cancel took: one the sweep or another cancel took
    // meanwhile already has its own record, and isn't in the client's email.
    const tookIds = new Set((await tx.hold.findMany({ where: { id: { in: ids }, cancelled_at: now, cancelled_by: userId }, select: { id: true } })).map(h => h.id))
    const took = live.filter(h => tookIds.has(h.id))
    if (took.length) await tx.auditLog.createMany({
      data: took.map(h => ({
        action:       'CANCEL_HOLD',
        truck_number: h.truck_number,
        user_id:      userId,
        hold_id:      h.id,
        details:      JSON.stringify({ client_name: h.client_name, status: h.status, reason, booking: bookingKey(h), via, previous_expires_at: h.expires_at?.toISOString() ?? null }),
      })),
    })
    return took
  })
  if (taken === null) return reply({ error: EXTEND_STALE_MESSAGE }, { status: 409 })
  if (taken.length === 0) return reply({ error: 'This reservation is no longer held, so there is nothing to cancel.' }, { status: 409 })

  // One email to the client for the whole booking, when there is a reason and an address.
  let emailed = false
  const client = taken.find(h => h.client_user?.email)?.client_user
  if (reason && client?.email) {
    const s = bookingSummary(taken)
    try {
      await sendCancellationEmail({
        to:           client.email,
        companyName:  client.company_name,
        truckNumbers: s.trucks,
        markets:      s.markets,
        startDate:    s.startDate,
        endDate:      s.endDate,
        reason,
      })
      emailed = true
    } catch (err) {
      console.error('[cancel] email send failed:', err)
    }
  }

  // The released trucks come off Salesforce's LED Trucks, or its next push would mirror them.
  const sfdcWarning = await syncOpportunityLedWindow(hold.sfdc_opportunity_id)
  return reply({ ok: true, cancelled: taken.length, emailed, sfdcWarning })
}

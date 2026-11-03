/**
 * The one set of rules for a person changing a booking's expiry, wherever
 * they do it: Reservations → Edit, approving a client's extension request,
 * the Extend link in the expiry reminder email, and a client's extension
 * request in the portal. Each path calls `expiryRefusal` with who is acting;
 * the writes live in lib/bookingExpiry.ts and the client route.
 *
 * The same everywhere:
 * - A booking is one quote: the date applies to every live hold of it, and
 *   its limit comes from its earliest market's start (lib/bookings.ts
 *   bookingCapStarts).
 * - A won deal is read-only (closedWonRefusal); a Closed Lost one would be
 *   released again by the reconcile, so it's refused until reopened.
 * - The date must be today or later, and a date past the limit is refused,
 *   never quietly cut back. The limit is 3 days before the first start for a
 *   client, 2 for staff (lib/holdExpiry.ts).
 * - A pending client request is answered by Approve or Deny. Nothing else
 *   changes the booking's expiry while it waits: Edit and the email link are
 *   refused, so a staff date and the client's asked date never overlap.
 * - Only staff Edit may bring an expiry in. The email link and a client's
 *   request only ever extend.
 *
 * Automatic expiries (a new booking, reinstate, the reconcile re-holding a
 * reopened deal) aren't a person's chosen date; they use bookingHoldExpiry,
 * which applies the same limit. Pure.
 */
import { CLIENT_MIN_DAYS_BEFORE_START, STAFF_MIN_DAYS_BEFORE_START, lastExpiryDate } from '@/lib/holdExpiry'
import { CLIENT_CONFIRMED, bookingCapStarts, closedWonRefusal } from '@/lib/bookings'
import { closedOpportunityBlocksReactivation } from '@/lib/sfdcIntegration'
import { centralDate } from '@/lib/dateOnly'

/** Who is changing the expiry. */
export type ExpiryActor = 'staff_edit' | 'staff_approve' | 'email' | 'client_request'

export type ExpiryRefusal = { status: 400 | 409; error: string; lastDate?: string }

type BookingHold = {
  status: string
  start_date: Date
  expires_at: Date | null
  sfdc_opportunity_id: string | null
}

type Stage = { isClosed: boolean; isWon: boolean; stageName: string } | null

/** What a client is told about a won or lost deal (no internal stage names or Salesforce steps). */
export { CLIENT_CONFIRMED }
export const CLIENT_CLOSED = 'This booking can no longer be extended. Contact your Lime Media representative.'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const isLive = (h: { status: string }) => h.status === 'HOLD' || h.status === 'EXTENSION_REQUESTED'

/** A client's limit is the standard runway; staff may pinch it to 2 days. */
export const minDaysBeforeStart = (actor: ExpiryActor) =>
  actor === 'client_request' ? CLIENT_MIN_DAYS_BEFORE_START : STAFF_MIN_DAYS_BEFORE_START

/** The start dates that cap the booking's one expiry (lib/bookings.ts bookingCapStarts). */
export function capStarts(booking: { status: string; start_date: Date }[], now: Date = new Date()): string[] {
  return bookingCapStarts(booking.map(h => ({ start_date: h.start_date.toISOString().slice(0, 10), status: h.status })), centralDate(now))
}

/** The last date (YYYY-MM-DD, Central) `actor` may set on this booking. */
export function bookingLastDate(booking: { status: string; start_date: Date }[], actor: ExpiryActor, now: Date = new Date()): string {
  return lastExpiryDate([...capStarts(booking, now)].sort()[0], now, minDaysBeforeStart(actor))
}

/** The latest Central date any live hold of the booking is held through, or null. */
export function heldThrough(booking: { status: string; expires_at: Date | null }[]): string | null {
  const dates = booking.filter(isLive).map(h => h.expires_at).filter((d): d is Date => !!d).map(d => centralDate(d)).sort()
  return dates.length ? dates[dates.length - 1] : null
}

/**
 * Why `actor` can't set this booking's expiry to `date` (YYYY-MM-DD,
 * Central), or null when it may. `stage` is the opportunity's Salesforce
 * stage, null when there's none or it couldn't be read.
 */
export function expiryRefusal(args: {
  actor: ExpiryActor
  date: string
  booking: BookingHold[]
  stage: Stage
  now?: Date
}): ExpiryRefusal | null {
  const { actor, date, booking, stage } = args
  const now = args.now ?? new Date()
  // Round-tripped: Date rolls a day past the month's end over (2026-02-31 is
  // March 3), which would pass the string comparisons below and write a later day.
  const parsed = new Date(`${date}T00:00:00Z`)
  if (!DATE.test(date) || isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return { status: 400, error: 'Invalid date' }
  const client = actor === 'client_request'

  // A client is told what it means for them, not the Salesforce steps staff take.
  const won = closedWonRefusal(booking, stage?.isClosed ? { isWon: stage.isWon } : null)
  if (won) return { status: 409, error: client ? CLIENT_CONFIRMED : won }
  const live = booking.filter(isLive)
  if (live.length === 0) return { status: 400, error: 'This booking has no live hold to change.' }

  const pending = live.some(h => h.status === 'EXTENSION_REQUESTED')
  if (actor === 'staff_approve' && !pending) return { status: 409, error: 'There is no extension request waiting on this booking.' }
  if (actor !== 'staff_approve' && pending) {
    return {
      status: 409,
      error: actor === 'client_request'
        ? 'An extension has already been requested for this booking.'
        : 'The client has asked to extend this reservation. Approve or deny the request on Reservations first.',
    }
  }

  const closed = closedOpportunityBlocksReactivation(stage)
  if (closed) return { status: 409, error: client ? CLIENT_CLOSED : `Can't change the expiry: ${closed}` }

  const today = centralDate(now)
  if (date < today) return { status: 400, error: `The expiry can't be in the past (today is ${today}).` }

  const lastDate = bookingLastDate(booking, actor, now)
  if (date > lastDate) {
    const days = minDaysBeforeStart(actor)
    return { status: 400, error: `The latest this booking can be held is ${lastDate}: ${days} days before its first market starts.`, lastDate }
  }

  // The email link moves the warned expiry later; it may bring it level with
  // another part of the booking but never set the booking earlier than that.
  // A client's request must ask for more than the booking already has.
  const through = heldThrough(booking)
  if (through && actor === 'email' && date < through) {
    return { status: 409, error: `Part of this reservation is already held through ${through}. Change its expiry on Reservations instead.` }
  }
  if (through && actor === 'client_request' && date <= through) {
    return { status: 400, error: `This booking is already held through ${through}. Choose a later date.` }
  }
  return null
}

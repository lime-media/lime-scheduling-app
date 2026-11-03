/**
 * The one set of rules for changing a booking's expiry (lib/expiryRules.ts).
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { bookingLastDate, expiryRefusal, heldThrough, type ExpiryActor } from '@/lib/expiryRules'
import { endOfDayCentral } from '@/lib/dateOnly'
import { CLOSED_WON_READ_ONLY } from '@/lib/bookings'

const now = new Date('2026-11-03T15:00:00Z') // 9am Central
const hold = (over: Partial<{ status: string; start: string; expires: string | null; opp: string | null }> = {}) => ({
  status: over.status ?? 'HOLD',
  start_date: new Date(`${over.start ?? '2026-11-20'}T00:00:00Z`),
  expires_at: over.expires === null ? null : endOfDayCentral(over.expires ?? '2026-11-05'),
  sfdc_opportunity_id: over.opp === undefined ? '006000000000001AAA' : over.opp,
})
const open = { isClosed: false, isWon: false, stageName: 'WARM' }
const lost = { isClosed: true, isWon: false, stageName: 'Closed Lost - Budget' }
const wonStage = { isClosed: true, isWon: true, stageName: 'Closed Won' }
const refuse = (actor: ExpiryActor, date: string, booking = [hold()], stage: typeof open | null = open) =>
  expiryRefusal({ actor, date, booking, stage, now })?.error ?? null

section('expiry rules: limits')
eq('staff limit is 2 days before the first start', bookingLastDate([hold()], 'staff_edit', now), '2026-11-17')
eq('client limit is 3 days before it', bookingLastDate([hold()], 'client_request', now), '2026-11-16')
eq('the earliest market of a multi-market booking caps it', bookingLastDate([hold(), hold({ start: '2026-11-12' })], 'staff_edit', now), '2026-11-09')
eq('staff may set the limit', refuse('staff_edit', '2026-11-17'), null)
eq('a day past it is refused, naming it', refuse('staff_edit', '2026-11-18'), 'The latest this booking can be held is 2026-11-17: 2 days before its first market starts.')
eq('a client asking past their limit is refused', refuse('client_request', '2026-11-17'), 'The latest this booking can be held is 2026-11-16: 3 days before its first market starts.')
eq('the past is refused', refuse('staff_edit', '2026-11-02'), "The expiry can't be in the past (today is 2026-11-03).")
eq('today is allowed', refuse('staff_edit', '2026-11-03'), null)
eq('a malformed date is refused', refuse('staff_edit', '2026-13-45x'), 'Invalid date')

section('expiry rules: shortening')
eq('staff Edit may bring an expiry in', refuse('staff_edit', '2026-11-04'), null)
eq('the email link never sets the booking earlier than part of it is held', refuse('email', '2026-11-06', [hold(), hold({ expires: '2026-11-07' })]), 'Part of this reservation is already held through 2026-11-07. Change its expiry on Reservations instead.')
eq('but may bring the warned hold level with it', refuse('email', '2026-11-07', [hold(), hold({ expires: '2026-11-07' })]), null)
eq('nor does a client request', refuse('client_request', '2026-11-04'), 'This booking is already held through 2026-11-05. Choose a later date.')
eq('the email link extends', refuse('email', '2026-11-06'), null)
eq('held through is the latest live hold', heldThrough([hold(), hold({ expires: '2026-11-07' }), hold({ status: 'EXPIRED', expires: '2026-11-09' })]), '2026-11-07')

section('expiry rules: a pending client request')
const pending = [hold({ status: 'EXTENSION_REQUESTED', expires: '2026-11-10' }), hold({ expires: '2026-11-10' })]
eq('staff Edit is blocked until it is answered', refuse('staff_edit', '2026-11-12', pending), 'The client has asked to extend this reservation. Approve or deny the request on Reservations first.')
eq('so is the email link', refuse('email', '2026-11-12', pending), 'The client has asked to extend this reservation. Approve or deny the request on Reservations first.')
eq('a second client request is refused', refuse('client_request', '2026-11-12', pending), 'An extension has already been requested for this booking.')
eq('approve answers it', refuse('staff_approve', '2026-11-10', pending), null)
eq('approve may give a shorter date than asked', refuse('staff_approve', '2026-11-08', pending), null)
eq('approve past the staff limit is refused, not cut back', refuse('staff_approve', '2026-11-18', pending), 'The latest this booking can be held is 2026-11-17: 2 days before its first market starts.')
eq('approve with nothing waiting is refused', refuse('staff_approve', '2026-11-10'), 'There is no extension request waiting on this booking.')

section('expiry rules: the deal')
const actors: ExpiryActor[] = ['staff_edit', 'staff_approve', 'email', 'client_request']
for (const a of actors) {
  const booking = a === 'staff_approve' ? pending : [hold()]
  eq(`${a}: Closed Won in Salesforce is read-only`, refuse(a, '2026-11-12', booking, wonStage), CLOSED_WON_READ_ONLY)
  eq(`${a}: Closed Lost is refused until reopened`, refuse(a, '2026-11-12', booking, lost)?.startsWith("Can't change the expiry: Its Salesforce Opportunity is \"Closed Lost - Budget\"") ?? false, true)
}
eq('a committed hold makes the booking read-only', refuse('staff_edit', '2026-11-12', [hold(), hold({ status: 'COMMITTED' })]), CLOSED_WON_READ_ONLY)
eq('an unknown stage (Salesforce unreachable) does not block', refuse('staff_edit', '2026-11-12', [hold()], null), null)
eq('a booking with nothing live is refused', refuse('staff_edit', '2026-11-12', [hold({ status: 'EXPIRED' })]), 'This booking has no live hold to change.')

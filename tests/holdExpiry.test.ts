/**
 * Hold expiration — the rule that decides how long a hold survives before the
 * hourly sweep expires it.
 *
 * The case that motivated the 24h floor: Firefly submitted a hold at midday on
 * 2026-09-15 for a 2026-09-18 start. The processing cap (start minus 3 days)
 * resolved to midnight that same morning — already past — so the hold was
 * written with an expiry equal to its own creation time, swept to EXPIRED
 * within the hour, and dropped off the Reservations page's default filter while
 * the client had been told the hold succeeded.
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { availableHoldDays, bookingHoldExpiry, lastExpiryDate, computeHoldExpiresAt, DEFAULT_HOLD_DAYS, HOLD_EXPIRATION_HOURS, MIN_HOLD_WINDOW_HOURS, STAFF_MIN_DAYS_BEFORE_START, holdExpiry, parseHoldDays } from '@/lib/holdExpiry'

const DAY_MS = 24 * 60 * 60 * 1000

/** yyyy-MM-dd for a date `days` from today, the format every caller passes. */
function startInDays(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().split('T')[0]
}

/** Hours of runway the returned expiry leaves, rounded — the number ops care about. */
function hoursOfRunway(startDate: string): number {
  return Math.round((computeHoldExpiresAt(startDate).getTime() - Date.now()) / (60 * 60 * 1000))
}

section('Hold expiration window')

// The regression. Before the floor this was 0 — the hold expired the instant it was created.
eq('start 3 days out gets the 24h floor', hoursOfRunway(startInDays(3)), MIN_HOLD_WINDOW_HOURS)

// Anything shorter is even further past the processing cap; the floor still holds.
eq('start tomorrow gets the 24h floor',   hoursOfRunway(startInDays(1)),  MIN_HOLD_WINDOW_HOURS)
eq('start today gets the 24h floor',      hoursOfRunway(startInDays(0)),  MIN_HOLD_WINDOW_HOURS)
eq('a start already past gets the floor', hoursOfRunway(startInDays(-5)), MIN_HOLD_WINDOW_HOURS)

// Long lead: nothing binds except the standard review SLA.
eq('start 30 days out gets the full SLA', hoursOfRunway(startInDays(30)), HOLD_EXPIRATION_HOURS)
eq('start 10 days out gets the full SLA', hoursOfRunway(startInDays(10)), HOLD_EXPIRATION_HOURS)

// The floor raises short windows; it must never extend a hold past the 72h SLA,
// and the cap must still bite between the two.
const runways = [0, 1, 2, 3, 4, 5, 6, 7, 14, 60].map(startInDays).map(hoursOfRunway)
eq('never below the floor', runways.every((h) => h >= MIN_HOLD_WINDOW_HOURS), true)
eq('never above the SLA',   runways.every((h) => h <= HOLD_EXPIRATION_HOURS), true)

// A hold is only ever placed against a future start, so the expiry must be too.
eq('expiry is always in the future', [0, 3, 30].map(startInDays).every((s) => computeHoldExpiresAt(s) > new Date()), true)

section('hold length chosen on the quote tool')
{
  const now = new Date('2026-10-16T15:00:00Z')
  const hrs = (d: Date) => Math.round((d.getTime() - now.getTime()) / 3600e3)
  const far = '2026-12-01'
  eq('default is 3 days', hrs(holdExpiry(far, undefined, now).expiresAt), 72)
  eq('a seller can hold 7 days', hrs(holdExpiry(far, 7, now).expiresAt), 168)
  eq('or 1 day', hrs(holdExpiry(far, 1, now).expiresAt), 24)
  eq('not cut short when the campaign is far off', holdExpiry(far, 7, now).cappedByStart, false)
  // Campaign Oct 27: a hold must end 3 days before, Oct 24 00:00 UTC.
  const soon = holdExpiry('2026-10-27', 14, now)
  eq('cut short by the campaign start', [soon.expiresAt.toISOString(), soon.cappedByStart], ['2026-10-23T23:59:59.000Z', true])
  eq('never under 24 hours, however soon the start', hrs(holdExpiry('2026-10-17', 7, now).expiresAt), 24)
  // Campaign Oct 19: 3 days before is Oct 16 00:00, already past, so the 24h floor decides.
  const floored = holdExpiry('2026-10-19', 7, now)
  eq('the floor, not the start, is the reason when it applies', [hrs(floored.expiresAt), floored.cappedByStart, floored.atMinimum], [24, false, true])
  eq('neither reason when the seller gets what they asked', [holdExpiry(far, 7, now).cappedByStart, holdExpiry(far, 7, now).atMinimum], [false, false])
  eq('a 1-day hold is not "at the minimum" when nothing cut it', holdExpiry(far, 1, now).atMinimum, false)
  eq('parse: missing means the standard 3', parseHoldDays(undefined), DEFAULT_HOLD_DAYS)
  eq('parse: 1 to 14 accepted', [parseHoldDays(1), parseHoldDays('14')], [1, 14])
  eq('parse: out of range or fractional refused', [parseHoldDays(0), parseHoldDays(15), parseHoldDays(2.5), parseHoldDays('x')], [null, null, null, null])
  eq('parse: no coercion (true is not 1 day, [7] is not 7)', [parseHoldDays(true), parseHoldDays([7]), parseHoldDays(' 7'), parseHoldDays('7')], [null, null, null, 7])
}

section('holdExpiry: which hold lengths the quote tools offer')
{
  // Noon UTC on a fixed day, so the cap (start minus 3 days, at midnight) lands mid-range.
  const now = new Date('2026-10-20T12:00:00Z')
  const all = Array.from({ length: 14 }, (_, i) => i + 1)
  eq('a far-off start: every length', availableHoldDays(['2026-12-01'], now), all)
  eq('no dates yet: every length', availableHoldDays([], now), all)
  // Start Oct 25: the cap is Oct 22 00:00, 36h away. 1 day (24h) fits; 2 days
  // (48h) is cut to 36h but still adds 12h; 3+ days add nothing.
  eq('a start 5 days out: only lengths that still add time', availableHoldDays(['2026-10-25'], now), [1, 2])
  eq('a disabled length really is cut short', holdExpiry('2026-10-25', 3, now).cappedByStart, true)
  // Start Oct 22: the cap is already past, so the 24h floor decides every length.
  eq('the 24-hour minimum: only 1 day', availableHoldDays(['2026-10-22'], now), [1])
  // Multi-market: one quote, one expiry, capped by the EARLIEST start.
  eq('multi-market: starts in 5 and 30+ days are limited by the 5-day one', availableHoldDays(['2026-10-25', '2026-11-20'], now), [1, 2])
  eq('the order of start dates does not matter', availableHoldDays(['2026-11-20', '2026-10-25'], now), [1, 2])
}

section('holdExpiry: a booking has one expiry, capped by its earliest start')
{
  const now = new Date('2026-10-20T12:00:00Z')
  const one = bookingHoldExpiry(['2026-11-20', '2026-10-25'], 7, now)
  eq('the earliest start decides', [one.startDate, one.expiresAt.toISOString(), one.cappedByStart], ['2026-10-25', '2026-10-21T23:59:59.000Z', true])
  eq('far-off starts: the seller\'s length', bookingHoldExpiry(['2026-12-01', '2026-12-15'], 7, now).expiresAt.toISOString(), '2026-10-27T12:00:00.000Z')
  eq('a revision keeps a later expiry it already had', bookingHoldExpiry(['2026-12-01'], 3, now, new Date('2026-11-01T23:59:59Z')).expiresAt.toISOString(), '2026-11-01T23:59:59.000Z')
  eq('but never past the earliest start\'s cap', bookingHoldExpiry(['2026-11-01'], 3, now, new Date('2026-11-01T23:59:59Z')).expiresAt.toISOString(), '2026-10-28T23:59:59.000Z')
  eq('the last date to set by hand: the day before the cap', lastExpiryDate('2026-11-20', now), '2026-11-16')
  eq('cap already past: the 24-hour floor\'s date', lastExpiryDate('2026-10-22', now), '2026-10-21')
}

section('holdExpiry: staff may hold until 2 days before the start; everyone else 3')
{
  const now = new Date('2026-10-20T12:00:00Z')
  eq('the staff runway is 2 days', STAFF_MIN_DAYS_BEFORE_START, 2)
  // Start Oct 25: the default cap is the end of Oct 21, the staff cap the end of Oct 22.
  eq('default (client portal, MCP, Salesforce): capped 3 days before', holdExpiry('2026-10-25', 7, now).expiresAt.toISOString(), '2026-10-21T23:59:59.000Z')
  eq('staff: capped 2 days before', holdExpiry('2026-10-25', 7, now, STAFF_MIN_DAYS_BEFORE_START).expiresAt.toISOString(), '2026-10-22T23:59:59.000Z')
  eq('staff: one more length worth offering', availableHoldDays(['2026-10-25'], now, STAFF_MIN_DAYS_BEFORE_START), [1, 2, 3])
  eq('staff, multi-market: the earliest start still decides', bookingHoldExpiry(['2026-11-20', '2026-10-25'], 7, now, null, STAFF_MIN_DAYS_BEFORE_START).expiresAt.toISOString(), '2026-10-22T23:59:59.000Z')
  eq('staff: the last date to set by hand', lastExpiryDate('2026-11-20', now, STAFF_MIN_DAYS_BEFORE_START), '2026-11-17')
  eq('staff: a kept expiry is capped at 2 days before', bookingHoldExpiry(['2026-11-01'], 3, now, new Date('2026-11-01T23:59:59Z'), STAFF_MIN_DAYS_BEFORE_START).expiresAt.toISOString(), '2026-10-29T23:59:59.000Z')
}

section('holdExpiry: an automatic cap and a hand-set date name the same last day')
{
  // #118 review: the cap was stored at 00:00Z the next day, so Edit opened on a
  // date one past its own max. A hand-set date expires at its day's end.
  const now = new Date('2026-10-20T12:00:00Z')
  // A 14-day hold from Oct 20 runs to Nov 3, past each of these caps.
  for (const [start, runway] of [['2026-10-30', STAFF_MIN_DAYS_BEFORE_START], ['2026-11-02', 3], ['2026-11-04', STAFF_MIN_DAYS_BEFORE_START]] as const) {
    const cap = bookingHoldExpiry([start], 14, now, null, runway)
    eq(`start ${start}, ${runway}-day runway: capped by the start`, cap.cappedByStart, true)
    const last = lastExpiryDate(start, now, runway)
    eq(`start ${start}, ${runway}-day runway: the capped expiry falls on the last allowed date`, cap.expiresAt.toISOString().slice(0, 10), last)
    eq(`start ${start}, ${runway}-day runway: and is that date's end`, cap.expiresAt.toISOString(), `${last}T23:59:59.000Z`)
  }
}

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
import { computeHoldExpiresAt, HOLD_EXPIRATION_HOURS, MIN_HOLD_WINDOW_HOURS } from '@/lib/holdExpiry'

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

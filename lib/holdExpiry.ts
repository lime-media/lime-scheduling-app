/**
 * Hold expiration policy.
 *
 * Split out from holdRequestService so it can be exercised by `npm test`, whose suites import
 * pure functions only — the service module reaches Samsara and Prisma through the feasibility
 * engine and cannot be loaded without credentials.
 */

// Standard review SLA — 72 hours (3 days) from submission.
// Exported so the Salesforce webhook can fall back to the same window when an
// Opportunity arrives with trucks/start/stop but no Hold Exp date.
export const HOLD_EXPIRATION_HOURS = 72
// The team needs this many full days of runway before a campaign starts to actually process an
// approved hold (route the truck, confirm logistics, etc.) — the same 3-day figure as the
// standard SLA above, but anchored to the campaign's start date instead of the submission time.
// The default for every caller: the client portal, MCP and the Salesforce fallback.
const MIN_PROCESSING_DAYS_BEFORE_START = 3
// Staff (the quote tools and Reservations) may pinch that runway to 2 days when a seller needs
// the longer hold. Staff callers pass it explicitly; nothing else does.
export const STAFF_MIN_DAYS_BEFORE_START = 2
// No hold may be created with less than this much review time, whatever the cap below works out
// to. Without it a short-lead request produced an expiry already in the past: the row was born
// expired, the next hourly sweep flipped it to EXPIRED, it fell off the Reservations page's
// default filter within the hour, and its truck read as free everywhere — while the client had
// been told the hold succeeded.
export const MIN_HOLD_WINDOW_HOURS = 24

function addHours(from: Date, hours: number): Date {
  return new Date(from.getTime() + hours * 60 * 60 * 1000)
}

/** How long a seller may hold trucks from the quote tool, in days. 3 (72h) is the default. */
export const DEFAULT_HOLD_DAYS = HOLD_EXPIRATION_HOURS / 24
export const MAX_HOLD_DAYS = 14

/** A seller's hold length, or null when it is not a whole number of days from 1 to MAX_HOLD_DAYS. */
export function parseHoldDays(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return DEFAULT_HOLD_DAYS
  // A number, or digits as text — not whatever Number() can coerce (true is 1, [7] is 7).
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 && n <= MAX_HOLD_DAYS ? n : null
}

/**
 * When a new hold expires, and why it is shorter than asked, if it is.
 *
 * The EARLIER of the hold length (default 72h; a seller may choose 1–14 days
 * on the quote tool) and the latest moment that still leaves
 * MIN_PROCESSING_DAYS_BEFORE_START full days before the campaign starts — but
 * never sooner than MIN_HOLD_WINDOW_HOURS from now. The floor wins over the
 * processing cap: a hold ops cannot see is worse than one that outlives its
 * logistics runway, and a short window is the signal to act today rather
 * than a reason to discard the request.
 *
 * At most one reason is true, and only when it decided `expiresAt`:
 * `cappedByStart` — it ends `minDaysBeforeStart` days (3, or 2 for staff) before the campaign starts;
 * `atMinimum` — the campaign starts so soon that the 24h floor applied.
 * Pure (pass `now`).
 */
export function holdExpiry(
  startDate: string, holdDays: number = DEFAULT_HOLD_DAYS, now: Date = new Date(), minDaysBeforeStart: number = MIN_PROCESSING_DAYS_BEFORE_START,
): { expiresAt: Date; cappedByStart: boolean; atMinimum: boolean } {
  const requested = addHours(now, holdDays * 24)

  const latestByStart = latestHoldMoment(startDate, minDaysBeforeStart)

  const startDecides = latestByStart < requested
  const capped = startDecides ? latestByStart : requested

  const floor = addHours(now, MIN_HOLD_WINDOW_HOURS)
  if (capped < floor) return { expiresAt: floor, cappedByStart: false, atMinimum: true }
  return { expiresAt: capped, cappedByStart: startDecides, atMinimum: false }
}

/**
 * A booking's one expiry. A multi-market booking is one quote, so every hold
 * in it lapses at the same moment: the seller's length, capped by the
 * EARLIEST start among `startDates` (`minDaysBeforeStart` days before it, with the 24-hour
 * floor), as holdExpiry decides for that start. `keepUntil` is an expiry the
 * booking already has (a revision never cuts back what ops extended): it is
 * kept when later, but never past that cap. Pure (pass `now`).
 */
export function bookingHoldExpiry(
  startDates: string[], holdDays: number = DEFAULT_HOLD_DAYS, now: Date = new Date(), keepUntil: Date | null = null,
  minDaysBeforeStart: number = MIN_PROCESSING_DAYS_BEFORE_START,
): { expiresAt: Date; cappedByStart: boolean; atMinimum: boolean; startDate: string } {
  const startDate = startDates.filter(Boolean).sort()[0]
  const base = holdExpiry(startDate, holdDays, now, minDaysBeforeStart)
  if (keepUntil && keepUntil > base.expiresAt) {
    const cap = latestHoldMoment(startDate, minDaysBeforeStart)
    const kept = keepUntil < cap ? keepUntil : cap
    if (kept > base.expiresAt) return { expiresAt: kept, cappedByStart: kept.getTime() === cap.getTime(), atMinimum: false, startDate }
  }
  return { ...base, startDate }
}

/**
 * The latest a hold may run for a campaign starting `startDate`: the END of
 * the day `minDaysBeforeStart` + 1 days before it (23:59:59Z), leaving
 * `minDaysBeforeStart` full days. It is the end of a day, not midnight
 * starting the next one, so an automatic cap and a date set by hand
 * (Reservations → Edit stores a date's end) name the same last day.
 */
function latestHoldMoment(startDate: string, minDaysBeforeStart: number = MIN_PROCESSING_DAYS_BEFORE_START): Date {
  const d = new Date(startDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - minDaysBeforeStart)
  return new Date(d.getTime() - 1000)
}

/**
 * The last date (YYYY-MM-DD) an expiry may be set to by hand (Reservations →
 * Edit), for a booking whose earliest start is `earliestStart`: the day the
 * automatic cap falls on (a hand-set date expires at that day's end, the same
 * moment), or the 24-hour floor's date when the cap has already passed. Pure.
 */
export function lastExpiryDate(earliestStart: string, now: Date = new Date(), minDaysBeforeStart: number = MIN_PROCESSING_DAYS_BEFORE_START): string {
  const byStart = latestHoldMoment(earliestStart, minDaysBeforeStart).toISOString().slice(0, 10)
  const floor = addHours(now, MIN_HOLD_WINDOW_HOURS).toISOString().slice(0, 10)
  return byStart > floor ? byStart : floor
}

/**
 * The hold lengths worth offering for a booking with these start dates: 1
 * day, and each longer length that still holds the trucks longer than one day
 * less would. The booking's one expiry is capped by its EARLIEST start
 * (bookingHoldExpiry), so past the point where that start (or the 24-hour
 * floor) decides, a longer length buys nothing and the quote tools disable
 * it rather than accept it and quietly cut it short. Pure (pass `now`).
 */
export function availableHoldDays(startDates: string[], now: Date = new Date(), minDaysBeforeStart: number = MIN_PROCESSING_DAYS_BEFORE_START): number[] {
  const earliest = startDates.filter(Boolean).sort()[0]
  const all = Array.from({ length: MAX_HOLD_DAYS }, (_, i) => i + 1)
  if (!earliest) return all
  const lapse = (n: number) => holdExpiry(earliest, n, now, minDaysBeforeStart).expiresAt.getTime()
  return all.filter(n => n === 1 || lapse(n) > lapse(n - 1))
}

/**
 * holdExpiry's date, for callers with no seller choice (the client portal,
 * Salesforce fallback, "approve extension" and "reinstate", which all use
 * the standard 72h).
 */
export function computeHoldExpiresAt(startDate: string, holdDays: number = DEFAULT_HOLD_DAYS): Date {
  return holdExpiry(startDate, holdDays).expiresAt
}

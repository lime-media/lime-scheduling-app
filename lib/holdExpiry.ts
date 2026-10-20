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
const MIN_PROCESSING_DAYS_BEFORE_START = 3
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
 * `cappedByStart` — it ends 3 days before the campaign starts;
 * `atMinimum` — the campaign starts so soon that the 24h floor applied.
 * Pure (pass `now`).
 */
export function holdExpiry(startDate: string, holdDays: number = DEFAULT_HOLD_DAYS, now: Date = new Date()): { expiresAt: Date; cappedByStart: boolean; atMinimum: boolean } {
  const requested = addHours(now, holdDays * 24)

  const latestByStart = new Date(startDate + 'T00:00:00Z')
  latestByStart.setUTCDate(latestByStart.getUTCDate() - MIN_PROCESSING_DAYS_BEFORE_START)

  const startDecides = latestByStart < requested
  const capped = startDecides ? latestByStart : requested

  const floor = addHours(now, MIN_HOLD_WINDOW_HOURS)
  if (capped < floor) return { expiresAt: floor, cappedByStart: false, atMinimum: true }
  return { expiresAt: capped, cappedByStart: startDecides, atMinimum: false }
}

/**
 * The hold lengths worth offering for these start dates: 1 day, and each
 * longer length that still holds the trucks longer than one day less would.
 * A length past the point where the start date (or the 24-hour floor) decides
 * the expiry buys nothing, so the quote tools disable it rather than accept
 * it and quietly cut it short. In a multi-market booking the LATEST start
 * decides: a length that still adds time there is worth choosing even though
 * earlier markets stop sooner. Pure (pass `now`).
 */
export function availableHoldDays(startDates: string[], now: Date = new Date()): number[] {
  const latest = startDates.filter(Boolean).sort().at(-1)
  const all = Array.from({ length: MAX_HOLD_DAYS }, (_, i) => i + 1)
  if (!latest) return all
  return all.filter(n => n === 1
    || holdExpiry(latest, n, now).expiresAt.getTime() > holdExpiry(latest, n - 1, now).expiresAt.getTime())
}

/**
 * holdExpiry's date, for callers with no seller choice (the client portal,
 * Salesforce fallback, "approve extension" and "reinstate", which all use
 * the standard 72h).
 */
export function computeHoldExpiresAt(startDate: string, holdDays: number = DEFAULT_HOLD_DAYS): Date {
  return holdExpiry(startDate, holdDays).expiresAt
}

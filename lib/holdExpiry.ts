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

/**
 * A hold's expiration is the EARLIER of the standard 72h review SLA and the latest moment that
 * still leaves MIN_PROCESSING_DAYS_BEFORE_START full days before the campaign starts — but never
 * sooner than MIN_HOLD_WINDOW_HOURS from now. The floor wins over the processing cap: a hold
 * ops cannot see is worse than one that outlives its logistics runway, and a short window is
 * the signal to act today rather than a reason to discard the request.
 *
 * Exported so the staff-side "approve extension" and "reinstate" actions can compute a new
 * expiry using the exact same rule — a fresh 72h SLA from the moment of approval, still capped
 * by the campaign start and still floored at 24h.
 */
export function computeHoldExpiresAt(startDate: string): Date {
  const now = new Date()

  const standardExpiry = addHours(now, HOLD_EXPIRATION_HOURS)

  const latestByStart = new Date(startDate + 'T00:00:00Z')
  latestByStart.setUTCDate(latestByStart.getUTCDate() - MIN_PROCESSING_DAYS_BEFORE_START)

  const capped = standardExpiry < latestByStart ? standardExpiry : latestByStart

  const floor = addHours(now, MIN_HOLD_WINDOW_HOURS)
  return capped > floor ? capped : floor
}

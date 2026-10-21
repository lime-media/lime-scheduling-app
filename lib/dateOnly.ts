import { parseISO } from 'date-fns'

/**
 * Parse a calendar-date field (e.g. a hold's start_date/end_date) for display, without
 * shifting by the viewer's timezone offset.
 *
 * These fields represent a day, not an instant — but depending on the API route, they can
 * arrive as either a bare "YYYY-MM-DD" string or a full ISO timestamp ("...T00:00:00.000Z").
 * `new Date(value)` parses either form as UTC, and `format()` then renders in the local
 * timezone — so on any machine west of UTC, "2026-08-17" silently displays as Aug 16.
 *
 * Slicing to the first 10 characters and parsing with `parseISO` sidesteps this: parseISO
 * treats a bare date as local midnight, matching how `format()` reads it back, so the
 * calendar day never shifts regardless of the viewer's timezone.
 */
export function parseDateOnly(value: string): Date {
  return parseISO(value.slice(0, 10))
}


/**
 * The zone a hold's dates are in: reps, confirmations, the expiry sweep's
 * emails and LED Hold Exp. A date-only expiry ("held until Thursday") means
 * the end of that day here.
 */
export const APP_TIME_ZONE = 'America/Chicago'

const CENTRAL_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })

/** The calendar day (YYYY-MM-DD) an instant falls on in Central time. */
export function centralDate(instant: Date): string {
  return CENTRAL_DAY.format(instant)
}

/** Today's date in Central time: what "today" means for expiries and caps. */
export function todayCentral(now: Date = new Date()): string {
  return centralDate(now)
}

/**
 * The end of a calendar day in Central time (the last second, :59.000, like
 * every end-of-day expiry the app stores): 04:59:59Z the next morning in
 * daylight time, 05:59:59Z in standard time. Midnight is never a DST change
 * (those happen at 2am), so it's one of the two.
 */
export function endOfDayCentral(value: string): Date {
  const day = value.slice(0, 10)
  const next = new Date(day + 'T00:00:00Z')
  next.setUTCDate(next.getUTCDate() + 1)
  const nextDay = next.toISOString().slice(0, 10)
  for (const hour of ['05', '06']) {
    const midnight = new Date(`${nextDay}T${hour}:00:00Z`)
    if (centralDate(midnight) === nextDay && centralDate(new Date(midnight.getTime() - 1)) === day) return new Date(midnight.getTime() - 1000)
  }
  return new Date(day + 'T23:59:59Z')
}

/**
 * The LED Hold Exp date to write to Salesforce for a hold expiring at
 * `expiresAt`: the day it lapses in Central time, the day the rep was told
 * ("held until Thu 8:00 PM CDT"). Its UTC date is a day late for an evening
 * expiry (Thu 8pm CDT is Fri 01:00Z). A Hold Exp read back from Salesforce
 * means the end of that day (endOfDayCentral), so the round trip keeps the day.
 */
export function holdExpDate(expiresAt: Date): string {
  return centralDate(expiresAt)
}

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
 * The last instant of a calendar day, in UTC.
 *
 * Salesforce sends Hold Exp as a bare "YYYY-MM-DD", and that date is the LAST
 * day the hold is valid — the truck is only released the day after (see the
 * expiry contract in lib/scheduleCache.ts). Parsing it with `new Date()` yields
 * 00:00Z, the *start* of that day, so comparing it against `now` releases the
 * hold a full calendar day early.
 *
 * The rest of the app already anchors date-only expirations to end-of-day —
 * see the `update_expiration` action in app/api/hold-requests/[id]/route.ts,
 * which builds `T23:59:59Z`. This keeps the Salesforce path on that convention.
 */
export function endOfDayUtc(value: string): Date {
  return new Date(value.slice(0, 10) + 'T23:59:59.999Z')
}

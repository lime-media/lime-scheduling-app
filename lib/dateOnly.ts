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

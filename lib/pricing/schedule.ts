/**
 * Campaign scheduling — the single definition of "how many days do we bill?"
 *
 * Billing is on ACTIVATION days (days a truck actually works), never on the
 * calendar span. A Mon-Fri campaign running two calendar weeks is 10 billable
 * days, not 14. Every quoting surface must agree on this number.
 */

/**
 * Default weekly schedule for a campaign of a given calendar length.
 * - 6 calendar days or fewer: run every day
 * - 7 or more: Mon-Fri, so weekends are neither worked nor billed
 */
export function defaultDaysPerWeek(calendarDays: number): 5 | 7 {
  return calendarDays <= 6 ? 7 : 5
}

/** Inclusive calendar span between two YYYY-MM-DD dates. */
export function countCalendarDays(startStr: string, endStr: string): number {
  const start = new Date(startStr + 'T00:00:00Z')
  const end = new Date(endStr + 'T00:00:00Z')
  return Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1
}

/**
 * Count activation days within a date range for a weekly schedule.
 * - 7 days/week: every calendar day
 * - 6 days/week: Mon-Sat (skip Sunday)
 * - 5 days/week: Mon-Fri (skip Saturday and Sunday)
 * - 1-4 days/week: that many days in each full week, plus up to that many in
 *   a final partial week. These days are not tied to weekdays: a truck that
 *   alternates between two markets (three days each) works whichever days the
 *   rotation gives it.
 *
 * Anything under 5 used to fall through to the 6-day rule, so a 3-day
 * schedule was billed as 6 days a week.
 */
export function countActivationDays(
  startStr: string,
  endStr: string,
  daysPerWeek: number,
): number {
  if (daysPerWeek === 7) return countCalendarDays(startStr, endStr)
  if (daysPerWeek >= 1 && daysPerWeek <= 4) {
    const calendar = countCalendarDays(startStr, endStr)
    const dpw = Math.floor(daysPerWeek)
    return Math.floor(calendar / 7) * dpw + Math.min(dpw, calendar % 7)
  }

  let count = 0
  const current = new Date(startStr + 'T00:00:00Z')
  const end = new Date(endStr + 'T00:00:00Z')

  while (current <= end) {
    const dow = current.getUTCDay() // 0=Sun, 6=Sat
    if (daysPerWeek === 5) {
      if (dow >= 1 && dow <= 5) count++
    } else {
      if (dow >= 1 && dow <= 6) count++
    }
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return count
}

/**
 * Calendar days from today until a campaign starts. Negative when in the past.
 * Both sides normalized to UTC midnight so a US-local "today" cannot drift a day.
 */
export function daysUntil(startStr: string, today = new Date()): number {
  const from = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const to = new Date(startStr + 'T00:00:00Z').getTime()
  return Math.round((to - from) / 86400000)
}

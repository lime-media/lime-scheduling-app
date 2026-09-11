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
 */
export function countActivationDays(
  startStr: string,
  endStr: string,
  daysPerWeek: number,
): number {
  if (daysPerWeek === 7) return countCalendarDays(startStr, endStr)

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

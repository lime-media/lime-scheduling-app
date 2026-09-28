/**
 * The pure rules behind AT&T soft holds (see lib/attSoftHolds.ts): which
 * client is AT&T, which trucks are AT&T's, and which months the rolling
 * window covers. No database,
 * so they can be tested and imported anywhere.
 */

/** The client AT&T books through. Compared trimmed and case-insensitive. */
export const ATT_CLIENT = '160over90'

/** Months kept ahead, counting the current one. */
export const WINDOW_MONTHS = 3

/**
 * A truck is AT&T's when it worked MORE than this many days for 160over90 in
 * a single month (each month counted on its own, never added together).
 */
export const ATT_MIN_DAYS = 5

/**
 * Through this day of the month, the prior month still counts: AT&T's
 * commitments for a new month drag into its first days, so a truck that was
 * AT&T's last month keeps its soft hold while the new month's shifts arrive.
 * From the next day on, only the current month counts.
 */
export const PRIOR_MONTH_GRACE_DAY = 10

const iso = (d: Date) => d.toISOString().slice(0, 10)
const utc = (s: string) => new Date(s + 'T00:00:00Z')

/** The months the window covers, as [holdStart, monthEnd]; the current month starts today. */
export function softHoldWindow(today: string): { start: string; end: string; label: string }[] {
  const t = utc(today)
  return Array.from({ length: WINDOW_MONTHS }, (_, i) => {
    const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + i, 1))
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + i + 1, 0))
    return {
      start: i === 0 ? today : iso(first),
      end: iso(last),
      label: first.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    }
  })
}

export const isAttClient = (client: unknown): boolean => String(client ?? '').trim().toLowerCase() === ATT_CLIENT.toLowerCase()

/** The months whose 160over90 days decide which trucks are AT&T's, as of `today`. */
export function attLookback(today: string): { current: { from: string; to: string }; prior: { from: string; to: string } | null } {
  const t = utc(today)
  const y = t.getUTCFullYear(), m = t.getUTCMonth()
  const month = (k: number) => ({ from: iso(new Date(Date.UTC(y, m + k, 1))), to: iso(new Date(Date.UTC(y, m + k + 1, 0))) })
  return { current: month(0), prior: t.getUTCDate() <= PRIOR_MONTH_GRACE_DAY ? month(-1) : null }
}

/**
 * Whether a truck is AT&T's, from its 160over90 days in each counted month.
 * More than ATT_MIN_DAYS in the current month; or, through the 10th, in the
 * prior month instead. `prior` is ignored when the lookback has no prior month.
 */
export function isAttTruck(days: { current: number; prior: number }, lookback: ReturnType<typeof attLookback>): boolean {
  return days.current > ATT_MIN_DAYS || (lookback.prior !== null && days.prior > ATT_MIN_DAYS)
}

/**
 * Whether an AT&T soft hold gives way on one day: only when another client's
 * shift is on THAT day. Soft holds cover whole months, so voiding the whole
 * hold for any overlapping shift would turn a month green for a one-day job
 * elsewhere — the grid, map and planner all use this per-day rule.
 */
export function softHoldYieldsOn(date: string, otherClientShifts: { shift_start: string; shift_end: string }[] | undefined): boolean {
  return (otherClientShifts ?? []).some(s => s.shift_start <= date && s.shift_end >= date)
}

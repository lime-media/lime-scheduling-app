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
 * the prior month and the current month together. A day or two on another
 * client's program does not change that.
 */
export const ATT_MIN_DAYS = 5

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

/** The days counted towards ATT_MIN_DAYS: the first of the prior month through the end of the current month. */
export function attLookback(today: string): { from: string; to: string } {
  const t = utc(today)
  return {
    from: iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1))),
    to: iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0))),
  }
}

/** Whether a count of 160over90 days in the lookback makes the truck AT&T's. */
export const isAttTruck = (days160over90: number): boolean => days160over90 > ATT_MIN_DAYS

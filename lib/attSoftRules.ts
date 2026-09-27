/**
 * The pure rules behind AT&T soft holds (see lib/attSoftHolds.ts): which
 * client is AT&T, and which months the rolling window covers. No database,
 * so they can be tested and imported anywhere.
 */

/** The client AT&T books through. Compared trimmed and case-insensitive. */
export const ATT_CLIENT = '160over90'

/** Months kept ahead, counting the current one. */
export const WINDOW_MONTHS = 3

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

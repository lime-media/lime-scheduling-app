/**
 * Date-range helpers shared by the AT&T soft-hold rules and conflict
 * detection. Dates are YYYY-MM-DD. Pure.
 */

const iso = (d: Date) => d.toISOString().slice(0, 10)
const utc = (s: string) => new Date(s + 'T00:00:00Z')

/**
 * The parts of [start, end] not covered by any of `taken` — the days a truck
 * still needs a soft hold for, after its existing soft holds and any dates
 * someone released for a booking. Dates are YYYY-MM-DD. Pure.
 */
export function freeRanges(start: string, end: string, taken: { start: string; end: string }[]): { start: string; end: string }[] {
  const next = (d: string) => iso(new Date(utc(d).getTime() + 864e5))
  const prev = (d: string) => iso(new Date(utc(d).getTime() - 864e5))
  const blocks = taken.filter(t => t.end >= start && t.start <= end).sort((a, b) => a.start.localeCompare(b.start))
  const out: { start: string; end: string }[] = []
  let cursor = start
  for (const b of blocks) {
    if (b.start > cursor) out.push({ start: cursor, end: prev(b.start) < end ? prev(b.start) : end })
    if (b.end >= cursor) cursor = next(b.end)
    if (cursor > end) return out
  }
  if (cursor <= end) out.push({ start: cursor, end })
  return out
}


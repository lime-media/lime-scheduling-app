/**
 * Sorting for the app's list tables (Reservations, Conflicts, the client
 * portal's reservations). Pure, so it can be tested.
 *
 * - Numbers inside text compare as numbers: truck 987 before 1043, "Truck 9"
 *   before "Truck 10". Case and accents are ignored.
 * - Blank values (null, undefined, '') always sort last, either direction —
 *   a column of mostly-empty "Expires" should still lead with real dates.
 * - Stable: rows that tie keep the order they arrived in (newest first from
 *   the API), so a second click never shuffles equal rows.
 */

export type SortDir = 'asc' | 'desc'
export type SortState<K extends string = string> = { by: K; dir: SortDir }
export type SortValue = string | number | null | undefined

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

const blank = (v: SortValue) => v === null || v === undefined || v === ''

/** Compare two non-blank values: numbers numerically, anything else as text. */
export function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return collator.compare(String(a), String(b))
}

/** `rows` sorted by `sort`, or unchanged (same order, new array) when there is none. */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  sort: SortState<K> | null,
  value: (row: T, key: K) => SortValue,
): T[] {
  if (!sort) return [...rows]
  const sign = sort.dir === 'desc' ? -1 : 1
  return rows
    .map((row, i) => ({ row, i, v: value(row, sort.by) }))
    .sort((a, b) => {
      const ab = blank(a.v), bb = blank(b.v)
      if (ab || bb) return ab === bb ? a.i - b.i : ab ? 1 : -1
      return sign * compareValues(a.v, b.v) || a.i - b.i
    })
    .map(x => x.row)
}

/** Clicking a header: a new column sorts ascending; the same column flips. */
export function nextSort<K extends string>(current: SortState<K> | null, by: K): SortState<K> {
  return { by, dir: current?.by === by && current.dir === 'asc' ? 'desc' : 'asc' }
}

/** The lowest value among several (a campaign's trucks), by the same rules; blank when all are. */
export function minValue(values: SortValue[]): SortValue {
  const real = values.filter(v => !blank(v))
  return real.length ? real.reduce((m, v) => (compareValues(v, m) < 0 ? v : m)) : null
}

/**
 * The planner's Sheet view: the ops spreadsheet layout, flat instead of an
 * outline. One row per driver + program + market + job # + truck, its day
 * cells beside it, every column sortable.
 *
 * Pure, so the grouping and sort order are tested (tests/planner.test.ts).
 */

import { primary, type Entry, type EntryKind } from '@/lib/planner/build'

export type SheetColumn = 'driver' | 'program' | 'market' | 'job' | 'truck'
export const SHEET_COLUMNS: { key: SheetColumn; label: string; width: number }[] = [
  { key: 'driver',  label: 'Driver',  width: 150 },
  { key: 'program', label: 'Program', width: 180 },
  { key: 'market',  label: 'Market',  width: 140 },
  { key: 'job',     label: 'Job #',   width: 96 },
  { key: 'truck',   label: 'Truck',   width: 64 },
]

export type SheetRow = {
  key: string
  driver: string
  program: string
  market: string
  job: string
  truck: string
  /** Every entry on each day, and the one the cell is coloured by. */
  cells: Record<string, Entry[]>
  top: Record<string, Entry>
}

/** Rows for the entries of the kinds shown. Open days are one row per truck. */
export function sheetRows(entries: Entry[], kinds: Set<EntryKind>): SheetRow[] {
  const rows = new Map<string, SheetRow>()
  for (const e of entries) {
    if (!kinds.has(e.kind)) continue
    const driver = e.driver ?? ''
    const program = e.campaign
    const market = e.market
    const job = e.jobNumber ?? ''
    const key = [driver, program, market, job, e.truck].join('|')
    let row = rows.get(key)
    if (!row) rows.set(key, (row = { key, driver, program, market, job, truck: e.truck, cells: {}, top: {} }))
    ;(row.cells[e.date] ??= []).push(e)
  }
  for (const row of rows.values()) {
    for (const [d, list] of Object.entries(row.cells)) row.top[d] = primary(list)
  }
  return [...rows.values()]
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/**
 * Sorted by one column, then the rest in sheet order (Driver, Program,
 * Market, Job #, Truck) so ties stay stable. Blanks sort last either way —
 * an unassigned driver never jumps to the top of a descending sort.
 */
export function sortSheet(rows: SheetRow[], by: SheetColumn, dir: 'asc' | 'desc'): SheetRow[] {
  const order: SheetColumn[] = [by, ...SHEET_COLUMNS.map(c => c.key).filter(k => k !== by)]
  return [...rows].sort((a, b) => {
    for (const [i, col] of order.entries()) {
      const x = a[col], y = b[col]
      if (x === y) continue
      if (!x) return 1
      if (!y) return -1
      const c = collator.compare(x, y)
      if (c !== 0) return i === 0 && dir === 'desc' ? -c : c
    }
    return 0
  })
}

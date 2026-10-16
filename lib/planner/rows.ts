/**
 * Editing the multi-market quote's market rows. Pure, so it can be tested and
 * used in the browser.
 */

type Dated = { id: string; startDate: string; endDate: string }

/**
 * Copy one row's start and end dates to every row below it — for a list of
 * markets that all run the same flight. Rows above are left alone, so a seller
 * can set a different flight partway down and copy that one on. Trucks,
 * schedule and hours stay per row. Unchanged rows keep their identity.
 */
export function copyDatesDown<T extends Dated>(rows: T[], fromId: string): T[] {
  const i = rows.findIndex(r => r.id === fromId)
  if (i < 0) return rows
  const { startDate, endDate } = rows[i]
  if (!startDate || !endDate) return rows
  return rows.map((r, j) => (j > i && (r.startDate !== startDate || r.endDate !== endDate) ? { ...r, startDate, endDate } : r))
}

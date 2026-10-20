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

/**
 * The start dates of a multi-market booking's holds: a truck's job starts on
 * its line's start date, or on the earlier of the two starts when it is
 * shared week to week with another booked market (lib/planning/order.ts
 * buildJobs). The booking has ONE expiry, capped by the earliest of these
 * (lib/holdExpiry.ts bookingHoldExpiry, as app/api/plan/hold applies it);
 * the planner's hold-length preview uses them to show that expiry.
 */
export function holdStartDates(
  lines: { market: string; startDate: string; assigned: { sharedWith: string | null }[] }[],
): string[] {
  const out = new Set<string>()
  for (const l of lines) {
    if (l.assigned.length === 0) out.add(l.startDate)
    for (const a of l.assigned) {
      const partner = a.sharedWith ? lines.find(p => p !== l && p.market === a.sharedWith) : undefined
      out.add(partner && partner.startDate < l.startDate ? partner.startDate : l.startDate)
    }
  }
  return [...out]
}

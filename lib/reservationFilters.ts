/**
 * Reservations page filters beyond status and text search: whose bookings
 * (owner = the staff user who created them) and which dates they run.
 * Like the search, a filter picks whole bookings, never part of one, so a
 * card, its total and its Edit always cover the same reservations. Pure.
 */

export type OwnerFilter = 'all' | 'me' | string // a user id

type Row = { created_by: string; created_by_name: string | null; start_date: string; end_date: string }

/** The owner choices: Everyone, Me, then everyone else who owns a reservation, by name. */
export function ownerOptions(rows: Row[], meId: string | null): { value: OwnerFilter; label: string }[] {
  const others = new Map<string, string>()
  for (const r of rows) {
    if (r.created_by && r.created_by !== meId && !others.has(r.created_by)) others.set(r.created_by, r.created_by_name || 'Unknown')
  }
  return [
    { value: 'all', label: 'Everyone' },
    ...(meId ? [{ value: 'me', label: 'Me' }] : []),
    ...[...others].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })),
  ]
}

/** Is this reservation owned by the chosen owner? */
export function ownedBy(row: Row, owner: OwnerFilter, meId: string | null): boolean {
  if (owner === 'all') return true
  return row.created_by === (owner === 'me' ? meId : owner)
}

/**
 * Does the reservation run on any day between `from` and `to` (YYYY-MM-DD,
 * either may be blank for an open end)? A single date in both is "running on
 * that day".
 */
export function runsBetween(row: Row, from: string, to: string): boolean {
  if (from && row.end_date < from) return false
  if (to && row.start_date > to) return false
  return true
}

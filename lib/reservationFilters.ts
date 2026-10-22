/**
 * Reservations page filters beyond status and text search: whose bookings
 * (owner = the Salesforce opportunity's owner, else the user who made the
 * reservation; lib/reservationOwners.ts) and which dates they run.
 * Like the search, a filter picks whole bookings, never part of one, so a
 * card, its total and its Edit always cover the same reservations. Pure.
 */

import { bookingKey } from '@/lib/bookings'

export type OwnerFilter = 'all' | 'me' | string // a user id

type Row = { owner_id: string; owner_name: string; start_date: string; end_date: string }

/** The owner choices: Everyone, Me, then everyone else who owns a reservation, by name. */
export function ownerOptions(rows: Row[], meId: string | null): { value: OwnerFilter; label: string }[] {
  const others = new Map<string, string>()
  for (const r of rows) {
    if (r.owner_id && r.owner_id !== meId && !others.has(r.owner_id)) others.set(r.owner_id, r.owner_name || 'Unknown')
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
  return row.owner_id === (owner === 'me' ? meId : owner)
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

/**
 * Every reservation of each booking that has at least one reservation
 * matching, and reservations on their own that match. A filter (owner, dates,
 * search) never splits a booking: one matching market keeps its whole card.
 */
export function wholeBookings<R extends { campaign_group_id: string | null; sfdc_opportunity_id: string | null }>(rows: R[], matches: (r: R) => boolean): R[] {
  const cards = new Set(rows.filter(matches).map(r => bookingKey(r)).filter(Boolean))
  return rows.filter((r) => { const k = bookingKey(r); return k ? cards.has(k) : matches(r) })
}

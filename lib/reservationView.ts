/**
 * The seller view on Reservations (app/hold-requests/page.tsx): the page's
 * listed reservations as bookings, the summary tiles over them, and what on a
 * booking needs someone's attention. Presentation only: every figure here is
 * one the page already shows (lib/bookings.ts summarizeBooking, bookingStatus,
 * bookingEnded), added up or flagged. No pricing, expiry or status rule is
 * decided here. Pure.
 */

import { bookingEnded, bookingKey, bookingStatus, summarizeBooking, type BookingRow } from '@/lib/bookings'
import { QUOTE_ONLY_ORIGINATION } from '@/lib/quoteOnly'

/**
 * "Expiring soon" on the tiles: the window the expiry reminder emails use
 * (lib/holdExpiryWarnings.ts WARN_WINDOW_HOURS), so the tile and the reminder
 * agree. Not imported from there: that module sends mail and can't be bundled
 * into the page. A test keeps the two equal.
 */
export const EXPIRING_SOON_HOURS = 24

export type ViewRow = BookingRow & {
  id: string
  status: string
  origination: string
  source: string
  truck_number: string
  market: string
  start_date: string
  end_date: string
  quoted_total: number | null
  pricing_tier?: string | null
  expires_at: string | null
  sfdc_account_id: string | null
  led_client: unknown | null
  led_trucks_unsynced_since: string | null
}

/**
 * The rows as bookings, in the order their first row appears (the API's
 * newest first): every row of a booking together (lib/bookings.ts
 * bookingKey), a row with no booking on its own.
 */
export function groupBookings<R extends BookingRow & { id: string }>(rows: R[]): { key: string; rows: R[] }[] {
  const out = new Map<string, R[]>()
  for (const r of rows) {
    const key = bookingKey(r) ?? `row:${r.id}`
    out.set(key, [...(out.get(key) ?? []), r])
  }
  return [...out].map(([key, rs]) => ({ key, rows: rs }))
}

export type Attention = 'extension_request' | 'no_quote' | 'no_opportunity' | 'led_client_unlinked' | 'led_trucks_unsynced'

/** What each flag says, on the tile and the booking's row. */
export const ATTENTION_LABEL: Record<Attention, string> = {
  extension_request: 'Extension request waiting',
  no_quote: 'No quote',
  no_opportunity: 'No Salesforce opportunity',
  led_client_unlinked: 'Account not linked to an LED client',
  led_trucks_unsynced: 'LED Trucks not updated in Salesforce',
}

const isQuoteOnly = (rows: { origination: string }[]) => rows.length > 0 && rows.every(r => r.origination === QUOTE_ONLY_ORIGINATION)

/**
 * What on a live booking (a reservation, a request waiting, or won) needs
 * someone to act, from what the page already knows. Expired, AT&T soft holds
 * and quote-only logs have none: nothing is reserved to fix.
 */
export function attentionOf(rows: ViewRow[]): Attention[] {
  if (!rows.length || isQuoteOnly(rows)) return []
  const { status } = bookingStatus(rows)
  if (status !== 'HOLD' && status !== 'EXTENSION_REQUESTED' && status !== 'COMMITTED') return []
  const live = rows.filter(r => r.status === status)
  const out: Attention[] = []
  if (status === 'EXTENSION_REQUESTED') out.push('extension_request')
  // No price on file for the booking, or for any market of it (lib/bookings.ts summarizeBooking).
  const priced = summarizeBooking(live)
  if (priced.total === null || priced.unpricedMarkets > 0) out.push('no_quote')
  if (!rows.some(r => r.sfdc_opportunity_id)) out.push('no_opportunity')
  if (status === 'COMMITTED' && rows.some(r => r.sfdc_account_id) && !rows.some(r => r.led_client)) out.push('led_client_unlinked')
  if (rows.some(r => r.led_trucks_unsynced_since)) out.push('led_trucks_unsynced')
  return out
}

/** A live booking's earliest expiry inside the "expiring soon" window (and not already past), else null. */
export function expiringSoon(rows: ViewRow[], now: Date): string | null {
  if (isQuoteOnly(rows)) return null
  const { status } = bookingStatus(rows)
  if (status !== 'HOLD' && status !== 'EXTENSION_REQUESTED') return null
  const e = summarizeBooking(rows.filter(r => r.status === status)).earliestExpiry
  if (!e) return null
  const ms = new Date(e).getTime() - now.getTime()
  return ms > 0 && ms <= EXPIRING_SOON_HOURS * 3600e3 ? e : null
}

export type SummaryTiles = {
  /** Reservations not yet won (requests waiting included): their quoted value, how many, how many missing a price for all or part of it. */
  open: { value: number; count: number; unpriced: number }
  /** Of those, expiring within EXPIRING_SOON_HOURS. */
  expiring: { value: number; count: number }
  /** Won bookings still running or upcoming (ended ones have their own filter). */
  won: { value: number; count: number; ledUnlinked: number }
  /** Live bookings with anything in attentionOf, and the count of each flag. */
  attention: { count: number; byKind: Partial<Record<Attention, number>> }
}

/**
 * The tiles over the bookings the page lists for the owner, dates and search
 * chosen (whatever the status tab). Values are the bookings' quoted totals as
 * their rows show them; an unpriced market adds nothing and is counted.
 */
export function summaryTiles(bookings: { rows: ViewRow[] }[], now: Date, today: string): SummaryTiles {
  const tiles: SummaryTiles = {
    open: { value: 0, count: 0, unpriced: 0 },
    expiring: { value: 0, count: 0 },
    won: { value: 0, count: 0, ledUnlinked: 0 },
    attention: { count: 0, byKind: {} },
  }
  for (const { rows } of bookings) {
    if (!rows.length || isQuoteOnly(rows)) continue
    const { status } = bookingStatus(rows)
    const live = rows.filter(r => r.status === status)
    const summary = summarizeBooking(live)
    const total = summary.total
    if (status === 'HOLD' || status === 'EXTENSION_REQUESTED') {
      tiles.open.count++
      tiles.open.value += total ?? 0
      if (total === null || summary.unpricedMarkets > 0) tiles.open.unpriced++
      if (expiringSoon(rows, now)) { tiles.expiring.count++; tiles.expiring.value += total ?? 0 }
    } else if (status === 'COMMITTED' && !bookingEnded(rows, today)) {
      tiles.won.count++
      tiles.won.value += total ?? 0
    }
    const flags = attentionOf(rows)
    if (status === 'COMMITTED' && flags.includes('led_client_unlinked') && !bookingEnded(rows, today)) tiles.won.ledUnlinked++
    if (flags.length) {
      tiles.attention.count++
      for (const f of flags) tiles.attention.byKind[f] = (tiles.attention.byKind[f] ?? 0) + 1
    }
  }
  return tiles
}

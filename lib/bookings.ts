/**
 * Which reservations belong to one booking, for the Reservations page.
 *
 * A multi-market quote writes one campaign group per market — `mm_<booking>_1`,
 * `mm_<booking>_2`, … (quote-only logs: `mmq_…`) — so each market keeps its
 * own figures for the client portal and Salesforce. On the Reservations page
 * that read as one reservation per market, each with its own Edit and
 * expiry. A booking is the unit people manage, so the page groups on the
 * booking: the multi-market prefix, else the campaign group, else the
 * Salesforce opportunity. Pure.
 */

type BookingRow = {
  campaign_group_id: string | null
  sfdc_opportunity_id: string | null
}

const MULTI_MARKET_GROUP = /^(mmq?_.+)_\d+$/

/** The booking a reservation belongs to, or null for one on its own. */
export function bookingKey(r: BookingRow): string | null {
  const multi = r.campaign_group_id?.match(MULTI_MARKET_GROUP)
  return multi ? multi[1] : r.campaign_group_id || r.sfdc_opportunity_id || null
}

/**
 * What one Reservations card shows: a booking's reservations in ONE status.
 * Each market's hold lapses on its own (it ends 3 days before its own start),
 * so a booking is often part on hold, part committed or expired. One card per
 * status keeps the card, its totals, its expiry and its Edit about exactly the
 * same reservations; the card notes the booking's other parts.
 */
export function bookingCardKey(r: BookingRow & { status: string }): string | null {
  const key = bookingKey(r)
  return key ? `${key}|${r.status}` : null
}

/** Whether a booking's reservations came from a multi-market quote. */
export const isMultiMarket = (r: BookingRow) => MULTI_MARKET_GROUP.test(r.campaign_group_id ?? '')

/**
 * A booking's headline figures. In a multi-market booking every hold carries
 * its own market's total, so the booking total adds one per market (campaign
 * group), not one per hold. Trucks are counted once each, even a truck that
 * alternates between two markets.
 */
export function summarizeBooking(rows: (BookingRow & {
  truck_number: string
  market: string
  start_date: string
  end_date: string
  quoted_total: number | null
  expires_at: string | null
  pricing_tier?: string | null
})[], wholeBooking?: { campaign_group_id: string | null }[]): { markets: string[]; trucks: number; total: number | null; unpricedMarkets: number; splitMarkets: number; tier: string | null; start: string; end: string; earliestExpiry: string | null } {
  // A market's price covers all its holds. When some of them are on another
  // card (another status), its price can't be shown here as if this card had
  // it all: it is left out and counted as split (`wholeBooking` = the
  // booking's rows across every status).
  const rowsIn = (rs: { campaign_group_id: string | null }[], g: string) => rs.filter(r => (r.campaign_group_id ?? '') === g).length
  const perGroup = new Map<string, number | null>()
  const split = new Set<string>()
  for (const r of rows) {
    const g = r.campaign_group_id ?? ''
    if (perGroup.has(g) || split.has(g)) continue
    if (wholeBooking && rowsIn(wholeBooking, g) > rowsIn(rows, g)) split.add(g)
    else perGroup.set(g, r.quoted_total)
  }
  const totals = [...perGroup.values()]
  const splitMarkets = split.size
  const expiries = rows.map(r => r.expires_at).filter((e): e is string => !!e).sort()
  const tiers = [...new Set(rows.map(r => r.pricing_tier).filter((t): t is string => !!t))]
  return {
    markets: [...new Set(rows.map(r => r.market))],
    trucks: new Set(rows.map(r => r.truck_number)).size,
    // The priced markets' total; a market with no price is counted, not taken as $0.
    total: totals.length === 0 || totals.every(t => t === null) ? null : totals.reduce<number>((n, t) => n + (t ?? 0), 0),
    unpricedMarkets: totals.filter(t => t === null).length,
    splitMarkets,
    // One tier for the card only when every market has it.
    tier: tiers.length === 1 ? tiers[0] : tiers.length > 1 ? 'Mixed' : null,
    start: rows.map(r => r.start_date).sort()[0],
    end: rows.map(r => r.end_date).sort().reverse()[0],
    earliestExpiry: expiries[0] ?? null,
  }
}

/** The last date (YYYY-MM-DD) a hold may run to and still leave 3 full days before its campaign starts (lib/holdExpiry.ts). */
function lastHoldDate(startDate: string): string {
  const d = new Date(startDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - 4)
  return d.toISOString().slice(0, 10)
}

/**
 * The start each hold's expiry is capped by: the start of its truck's job.
 * A truck that alternates weekly between two markets has one hold per
 * stretch, but the server capped them all by the job's first day
 * (app/api/plan/hold, holdExpiry(job.start)). Back-to-back stretches of one
 * truck (no day between them) are one job.
 */
function jobStarts(rows: { id: string; truck_number: string; start_date: string; end_date: string }[]): Map<string, string> {
  const out = new Map<string, string>()
  const byTruck = new Map<string, typeof rows>()
  for (const r of rows) byTruck.set(r.truck_number, [...(byTruck.get(r.truck_number) ?? []), r])
  const nextDay = (d: string) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10) }
  for (const stretches of byTruck.values()) {
    let start = '', end = ''
    for (const r of [...stretches].sort((x, y) => x.start_date.localeCompare(y.start_date))) {
      if (!start || r.start_date > nextDay(end)) start = r.start_date
      if (!end || r.end_date > end) end = r.end_date
      out.set(r.id, start)
    }
  }
  return out
}

/**
 * What one expiry change in a booking's Edit dialog does to each hold.
 *
 * Moving the date EARLIER than the booking's soonest expiry applies to every
 * hold. EXTENDING never shortens a hold: each keeps the later of its own
 * expiry and the date chosen. And when the booking's jobs start on different
 * dates (a multi-market booking), a hold stops at its job's 3-days-before-start
 * limit, or keeps a later expiry it already has, so extending can't run an
 * earlier market into its campaign. One start date: no limit, as before.
 * `changed` is false for a hold already on its resulting date. Pure.
 */
export function expiryEdits(
  rows: { id: string; market: string; truck_number: string; start_date: string; end_date: string; expires_at: string | null }[],
  chosen: string,
): { id: string; market: string; expiresOn: string; heldAtStartLimit: boolean; changed: boolean }[] {
  const starts = jobStarts(rows)
  const oneStart = new Set(starts.values()).size <= 1
  const earliest = earliestExpiryDate(rows)
  const extending = !earliest || chosen > earliest
  return rows.map(r => {
    const current = r.expires_at ? r.expires_at.slice(0, 10) : null
    if (!extending) return { id: r.id, market: r.market, expiresOn: chosen, heldAtStartLimit: false, changed: chosen !== current }
    const limit = lastHoldDate(starts.get(r.id) ?? r.start_date)
    const heldAtStartLimit = !oneStart && chosen > limit
    const later = current && current > chosen ? current : chosen
    const expiresOn = heldAtStartLimit ? (current && current > limit ? current : limit) : later
    return { id: r.id, market: r.market, expiresOn, heldAtStartLimit, changed: expiresOn !== current }
  })
}

/** The date (YYYY-MM-DD) the booking's soonest hold expires, as its card's badge shows. */
export function earliestExpiryDate(rows: { expires_at: string | null }[]): string {
  const dates = rows.map(r => r.expires_at?.slice(0, 10)).filter((d): d is string => !!d).sort()
  return dates[0] ?? ''
}

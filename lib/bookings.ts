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
})[]): { markets: string[]; trucks: number; total: number | null; unpricedMarkets: number; tier: string | null; start: string; end: string; earliestExpiry: string | null } {
  const perGroup = new Map<string, number | null>()
  for (const r of rows) if (!perGroup.has(r.campaign_group_id ?? '')) perGroup.set(r.campaign_group_id ?? '', r.quoted_total)
  const totals = [...perGroup.values()]
  const expiries = rows.map(r => r.expires_at).filter((e): e is string => !!e).sort()
  const tiers = [...new Set(rows.map(r => r.pricing_tier).filter((t): t is string => !!t))]
  return {
    markets: [...new Set(rows.map(r => r.market))],
    trucks: new Set(rows.map(r => r.truck_number)).size,
    // The priced markets' total; a market with no price is counted, not taken as $0.
    total: totals.every(t => t === null) ? null : totals.reduce<number>((n, t) => n + (t ?? 0), 0),
    unpricedMarkets: totals.filter(t => t === null).length,
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
 * What one expiry change in a booking's Edit dialog does to each hold.
 *
 * One booking, one start date (a single market): every hold takes the date
 * chosen, as before. A multi-market booking whose markets start on different
 * dates: a market whose 3-days-before-start limit falls before the chosen
 * date stops at that limit (or keeps a later expiry it already has), so
 * extending the booking can't run an earlier market's hold into its campaign.
 * `changed` is false for a hold already on its resulting date. Pure.
 */
export function expiryEdits(
  rows: { id: string; market: string; start_date: string; expires_at: string | null }[],
  chosen: string,
): { id: string; market: string; expiresOn: string; heldAtStartLimit: boolean; changed: boolean }[] {
  const oneStart = new Set(rows.map(r => r.start_date)).size <= 1
  return rows.map(r => {
    const current = r.expires_at ? r.expires_at.slice(0, 10) : null
    const limit = lastHoldDate(r.start_date)
    const heldAtStartLimit = !oneStart && chosen > limit
    const expiresOn = heldAtStartLimit ? (current && current > limit ? current : limit) : chosen
    return { id: r.id, market: r.market, expiresOn, heldAtStartLimit, changed: expiresOn !== current }
  })
}

/** The date (YYYY-MM-DD) the booking's soonest hold expires, as its card's badge shows. */
export function earliestExpiryDate(rows: { expires_at: string | null }[]): string {
  const dates = rows.map(r => r.expires_at?.slice(0, 10)).filter((d): d is string => !!d).sort()
  return dates[0] ?? ''
}

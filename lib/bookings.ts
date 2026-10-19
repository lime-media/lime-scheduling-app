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

import { QUOTE_ONLY_NO_TRUCK, QUOTE_ONLY_ORIGINATION } from '@/lib/quoteOnly'

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

// ---------------------------------------------------------------------------
// Revising a booking (Reservations → Revise → the multi-market planner)
// ---------------------------------------------------------------------------

/** A hold as revising reads it. Dates YYYY-MM-DD. */
export type RevisableHold = BookingRow & {
  id: string
  truck_number: string
  market: string
  start_date: string
  end_date: string
  status: string
  source: string
  origination: string | null
  features: string | null
  truck_count: number | null
  /** Still reserving its truck now (lib/holdFilters.ts holdReservesNow). */
  live: boolean
}

/** One market of a booking, as the planner's rows take it, with the trucks it holds now. */
export type RevisedRow = {
  market: string
  startDate: string
  endDate: string
  trucks: number
  daysPerWeek: number
  hours: number
  /** Trucks this market holds now and should keep where they still fit (live bookings only). */
  keepTrucks: string[]
}

/** Not a real truck: what quote-only logs carry when no truck could be priced. */
const NO_TRUCK = new Set([QUOTE_ONLY_NO_TRUCK, ''])

const parseFeatures = (json: string | null): Record<string, unknown> => {
  try { return json ? JSON.parse(json) : {} } catch { return {} }
}

/**
 * Why a booking cannot be revised in the planner, or null. Only bookings made
 * in the quote tools: a Salesforce push is managed in Salesforce, and a client
 * portal booking belongs to the client. Lift studies are a single-market
 * option the multi-market quote does not price, so revising would drop them.
 */
export function reviseRefusal(holds: RevisableHold[]): string | null {
  if (holds.length === 0) return 'That booking no longer exists.'
  if (holds.some(h => h.source !== 'INTERNAL')) {
    return holds.some(h => h.source === 'SALESFORCE')
      ? 'This booking came from Salesforce; change it there.'
      : 'This booking was made in the client portal; it can only be changed with the client.'
  }
  if (holds.some(h => {
    const f = parseFeatures(h.features)
    return Array.isArray(f.studies) && f.studies.length > 0
  })) return 'This booking includes lift studies, which the multi-market quote does not price. Change it in the single-market quote instead.'
  return null
}

/**
 * A booking's markets as planner rows, and its options. Each market is a
 * campaign group: its dates span its holds, its truck count is what was
 * booked, and its schedule and hours come from the stored quote. A booking
 * that is still live keeps its trucks (`keepTrucks`); an expired one is
 * re-picked and re-priced, so it keeps none. Pure.
 */
export function reviseRows(holds: RevisableHold[]): {
  rows: RevisedRow[]
  features: { shadowFencing: boolean; smartDirectional: boolean; deviceId: boolean }
  live: boolean
  quoteOnly: boolean
} {
  const live = holds.some(h => h.live)
  const byGroup = new Map<string, RevisableHold[]>()
  for (const h of holds) {
    const g = h.campaign_group_id ?? h.id
    byGroup.set(g, [...(byGroup.get(g) ?? []), h])
  }
  const rows = [...byGroup.values()].map(group => {
    const f = parseFeatures(group[0].features)
    const trucks = [...new Set(group.map(h => h.truck_number).filter(t => !NO_TRUCK.has(t)))]
    return {
      market: group[0].market,
      startDate: group.map(h => h.start_date).sort()[0],
      endDate: group.map(h => h.end_date).sort().reverse()[0],
      trucks: Math.max(1, group[0].truck_count ?? (Number(f.truckCount) || trucks.length || 1)),
      daysPerWeek: Number(f.daysPerWeek) || 5,
      hours: Number(f.operatingHours) || 8,
      keepTrucks: live ? trucks : [],
    }
  }).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.market.localeCompare(b.market))
  const f = parseFeatures(holds.find(h => h.features)?.features ?? null)
  return {
    rows,
    features: {
      shadowFencing: Number(f.shadowFencing) > 0,
      smartDirectional: f.smartDirectionalIncluded === true,
      deviceId: f.deviceIdIncluded === true,
    },
    live,
    quoteOnly: holds.every(h => h.origination === QUOTE_ONLY_ORIGINATION),
  }
}

/** A market whose booked price a revision keeps. */
export type KeptPrice = { total: number; features: string | null; trucks: string[] }

/**
 * Markets of a LIVE booking that a revision leaves unchanged — same market
 * (case and spacing aside), dates, trucks, schedule and hours, with the
 * booking's options unchanged — keep their booked price: a revision never
 * quietly reprices what the client already has (transport stops being free
 * as a campaign gets close, for instance). The planner applies it only where
 * the market also keeps its trucks (lib/planning/quote.ts). An expired
 * booking keeps no prices. Keyed by the request row's id. Pure.
 */
export function keptPrices(
  holds: (RevisableHold & { quoted_total: number | null })[],
  rows: { id: string; market: string; startDate: string; endDate: string; trucks: number; daysPerWeek: number; hours: number }[],
  features: { shadowFencing: boolean; smartDirectional: boolean; deviceId: boolean },
): Map<string, KeptPrice> {
  const out = new Map<string, KeptPrice>()
  const booked = reviseRows(holds)
  if (!booked.live || booked.quoteOnly) return out
  const sameOptions = booked.features.shadowFencing === features.shadowFencing
    && booked.features.smartDirectional === features.smartDirectional
    && booked.features.deviceId === features.deviceId
  if (!sameOptions) return out
  const norm = (m: string) => m.trim().toLowerCase().replace(/\s+/g, ' ')
  for (const row of rows) {
    const b = booked.rows.find(x => norm(x.market) === norm(row.market))
    if (!b || b.startDate !== row.startDate || b.endDate !== row.endDate || b.trucks !== row.trucks
      || b.daysPerWeek !== row.daysPerWeek || b.hours !== row.hours) continue
    const group = holds.filter(h => norm(h.market) === norm(row.market) && h.live)
    const total = group.find(h => h.quoted_total != null)?.quoted_total
    if (total == null) continue
    out.set(row.id, { total, features: group.find(h => h.features)?.features ?? null, trucks: b.keepTrucks })
  }
  return out
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

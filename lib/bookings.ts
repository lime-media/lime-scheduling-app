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

/**
 * A multi-market card's markets, for showing each as its own subgroup: one per
 * market line (campaign group), with its dates and length, its trucks under it.
 * Ordered by start date, then market, so the card reads as the flight runs.
 * `days` is the quoted activation days when the hold carries them (features),
 * else the calendar days of the market's dates; `daysKind` says which.
 */
export function marketGroups<R extends BookingRow & { truck_number: string; market: string; start_date: string; end_date: string; features?: string | null }>(rows: R[]): {
  key: string; market: string; start: string; end: string; days: number; daysKind: 'activation' | 'calendar'; rows: R[]
}[] {
  const groups = new Map<string, R[]>()
  for (const r of rows) {
    const g = r.campaign_group_id ?? r.market
    groups.set(g, [...(groups.get(g) ?? []), r])
  }
  return [...groups].map(([key, rs]) => {
    const start = rs.map(r => r.start_date.slice(0, 10)).sort()[0]
    const end = rs.map(r => r.end_date.slice(0, 10)).sort().reverse()[0]
    const activation = rs.map(r => activationDaysOf(r.features)).find((d): d is number => d !== null)
    const calendar = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1
    return {
      key, market: rs[0].market, start, end,
      days: activation ?? calendar, daysKind: activation !== undefined ? 'activation' as const : 'calendar' as const,
      rows: [...rs].sort((a, b) => a.start_date.localeCompare(b.start_date) || a.truck_number.localeCompare(b.truck_number, 'en', { numeric: true })),
    }
  }).sort((a, b) => a.start.localeCompare(b.start) || a.market.localeCompare(b.market) || a.key.localeCompare(b.key))
}

/** The quoted activation days stored on a hold's features, if any. */
function activationDaysOf(features: string | null | undefined): number | null {
  if (!features) return null
  try {
    const d = (JSON.parse(features) as { activationDays?: unknown }).activationDays
    return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : null
  } catch {
    return null
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
  /** The campaign group this market was booked as. */
  campaignGroup: string
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
  // Revising replaces the holds, which would drop the request unanswered.
  if (holds.some(h => h.status === 'EXTENSION_REQUESTED')) return 'This booking has an extension request waiting. Approve or decline it on Reservations first, then revise.'
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
  /** The Brand Direct markup it was sold at, or null when the holds predate recording it. */
  brandMarkupPct: number | null
} {
  const live = holds.some(h => h.live)
  const byGroup = new Map<string, RevisableHold[]>()
  for (const h of holds) {
    const g = h.campaign_group_id ?? h.id
    byGroup.set(g, [...(byGroup.get(g) ?? []), h])
  }
  const rows = [...byGroup.entries()].map(([campaignGroup, group]) => {
    const f = parseFeatures(group[0].features)
    const trucks = [...new Set(group.map(h => h.truck_number).filter(t => !NO_TRUCK.has(t)))]
    // The dates the client asked for, as booked. Older holds don't store
    // them: their span is the best there is (a shared truck's travel days
    // can widen or shift it).
    const asked = (k: string) => (typeof f[k] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f[k] as string) ? f[k] as string : null)
    return {
      market: group[0].market,
      startDate: asked('requestedStart') ?? group.map(h => h.start_date).sort()[0],
      endDate: asked('requestedEnd') ?? group.map(h => h.end_date).sort().reverse()[0],
      trucks: Math.max(1, group[0].truck_count ?? (Number(f.truckCount) || trucks.length || 1)),
      daysPerWeek: Number(f.daysPerWeek) || 5,
      hours: Number(f.operatingHours) || 8,
      keepTrucks: live ? trucks : [],
      campaignGroup,
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
    brandMarkupPct: typeof f.brandMarkupPct === 'number' ? f.brandMarkupPct : null,
  }
}

/** A market whose booked price a revision keeps, for the truck count and Brand Direct markup (null: not recorded) it was booked with. */
export type KeptPrice = { total: number; features: string | null; trucks: string[]; truckCount: number; markupPct: number | null }

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
  const used = new Set<string>()
  for (const row of rows) {
    // The same market can be booked twice (two flights): match on its dates too, and each booked market once.
    const b = booked.rows.find(x => !used.has(x.campaignGroup) && norm(x.market) === norm(row.market)
      && x.startDate === row.startDate && x.endDate === row.endDate)
    if (!b || b.trucks !== row.trucks || b.daysPerWeek !== row.daysPerWeek || b.hours !== row.hours) continue
    used.add(b.campaignGroup)
    // That market's own holds, not another flight's in the same market.
    const group = holds.filter(h => (h.campaign_group_id ?? h.id) === b.campaignGroup && h.live)
    const total = group.find(h => h.quoted_total != null)?.quoted_total
    if (total == null) continue
    const features = group.find(h => h.features)?.features ?? null
    const markup = parseFeatures(features).brandMarkupPct
    out.set(row.id, { total, features, trucks: b.keepTrucks, truckCount: b.trucks, markupPct: typeof markup === 'number' ? markup : null })
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

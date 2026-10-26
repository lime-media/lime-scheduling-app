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
import { centralDate } from '@/lib/dateOnly'

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
 * A booking's one status, for its card on Reservations and in the client
 * portal. A booking is one quote: it is booked, committed (Closed Won),
 * extended and expired as a whole, so its holds share a status. Bookings made
 * before the one-expiry rule (#118) could lapse market by market; for those
 * the card still shows the booking whole, under the status that needs action
 * first, and `odd` lists the markets in any other status. Pure.
 */
const STATUS_PRIORITY = ['EXTENSION_REQUESTED', 'HOLD', 'COMMITTED', 'EXPIRED']

export function bookingStatus(rows: { status: string; market: string }[]): { status: string; odd: { status: string; markets: string[] }[] } {
  const rank = (s: string) => { const i = STATUS_PRIORITY.indexOf(s); return i < 0 ? STATUS_PRIORITY.length : i }
  const present = [...new Set(rows.map(r => r.status))].sort((a, b) => rank(a) - rank(b))
  const status = present[0] ?? ''
  const odd = present.slice(1).map(s => ({
    status: s,
    markets: [...new Set(rows.filter(r => r.status === s).map(r => r.market))],
  }))
  return { status, odd }
}

/**
 * How much of a booking's committed (won) part LED has scheduled, in truck-days:
 * the days each hold's job runs on its truck in LED, of the days sold on it
 * (lib/ledJobs.ts), over the committed holds that have a job number to match
 * on. `known` is false when none has one yet. Null when nothing in it is
 * committed. Pure.
 */
export function ledProgress(rows: { status: string; led_days?: number; led_days_sold?: number | null }[]): { days: number; of: number; known: boolean } | null {
  const committed = rows.filter(r => r.status === 'COMMITTED')
  if (!committed.length) return null
  const matched = committed.filter(r => r.led_days_sold != null)
  return {
    days: matched.reduce((n, r) => n + Math.min(r.led_days ?? 0, r.led_days_sold ?? 0), 0),
    of: matched.reduce((n, r) => n + (r.led_days_sold ?? 0), 0),
    known: matched.length > 0,
  }
}

/**
 * A booking LED has fully taken over: every live hold is committed and
 * scheduled in LED. Reservations stops listing it (outside its own filter);
 * the LED schedule blocks the trucks from then on. Pure.
 */
export function bookingInLed(rows: { status: string; led_scheduled?: boolean }[]): boolean {
  const live = rows.filter(r => r.status === 'HOLD' || r.status === 'EXTENSION_REQUESTED' || r.status === 'COMMITTED')
  return live.length > 0 && live.every(r => r.status === 'COMMITTED' && r.led_scheduled)
}

/** What staff are told when a change would touch a won deal. */
export const CLOSED_WON_READ_ONLY = 'This deal is Closed Won in Salesforce; change it there first.'

/**
 * Why a change to a booking is refused because the deal is won, or null.
 * Closed Won is read-only in the app: only a truck swap (ops logistics, the
 * deal unchanged) may touch it. A committed hold on an opportunity IS a won
 * deal: only Salesforce commits holds (the reconcile, or a PUT that checks the
 * stage), and the reconcile un-commits them if the deal leaves Closed Won, so
 * "change it in Salesforce first" always has a way back. A committed hold with
 * no opportunity has no Salesforce side to change, so it is never locked.
 * `opportunity.isWon` covers the minutes before the reconcile catches up. Pure.
 */
export function closedWonRefusal(holds: { status: string; sfdc_opportunity_id: string | null }[], opportunity?: { isWon: boolean } | null): string | null {
  return opportunity?.isWon || holds.some(h => h.status === 'COMMITTED' && !!h.sfdc_opportunity_id) ? CLOSED_WON_READ_ONLY : null
}

/**
 * The holds of a lapsed booking that Reinstate brings back: the lapsed ones
 * whose dates haven't all passed. A market that already ended stays expired —
 * there's nothing left to hold, and its past dates mustn't be clash-checked
 * or listed in Salesforce. Pure.
 */
export function reinstatableHolds<H extends { status: string; end_date: Date | string }>(holds: H[], today: string): H[] {
  const day = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 10)
  return holds.filter(h => h.status === 'EXPIRED' && day(h.end_date) >= today)
}

/** What a rep is told when every lapsed market of a booking has already ended. */
export const NOTHING_TO_REINSTATE = "Can't reinstate: every market of this booking has already ended. To book these trucks again, get a fresh quote."

/**
 * Why a booking can't be reinstated, or null: reinstating is all or nothing
 * (a booking is one quote), so any truck booked by someone else since it
 * lapsed refuses the whole booking, naming each one. Only then is anything
 * reinstated or written to Salesforce, which therefore never lists a truck the
 * app didn't take back. Pure.
 */
export function reinstateRefusal(clashes: { truck: string; client: string; start: string; end: string }[]): string | null {
  if (clashes.length === 0) return null
  const list = clashes.map(c => `truck ${c.truck} (${c.client}, ${c.start} to ${c.end})`).join('; ')
  return `Can't reinstate: ${clashes.length === 1 ? 'a truck has' : 'trucks have'} been booked since this lapsed: ${list}. `
    + 'Revise the booking to pick other trucks (a Salesforce booking: change its trucks in Salesforce).'
}

/**
 * Why a client may not ask to extend this booking, or null. A request covers
 * the whole booking, so every live hold in it must be an ordinary reservation:
 * a committed (won) booking has nothing to extend, an expired one has lapsed,
 * a request may already be waiting, and an AT&T soft hold is never a
 * client's. Pure.
 */
export function clientExtendRefusal(holds: { status: string }[]): string | null {
  const live = holds.filter(h => h.status !== 'EXPIRED')
  if (live.some(h => h.status === 'COMMITTED')) return 'This booking is confirmed; there is no hold to extend.'
  if (live.some(h => h.status === 'EXTENSION_REQUESTED')) return 'An extension has already been requested for this booking.'
  if (live.length === 0) return 'This booking has expired and can no longer be extended.'
  if (live.some(h => h.status !== 'HOLD')) return 'This booking cannot be extended.'
  return null
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
 * portal booking belongs to the client. A committed (Closed Won) booking is
 * changed in Salesforce, never here. Lift studies are a single-market
 * option the multi-market quote does not price, so revising would drop them.
 */
export function reviseRefusal(holds: RevisableHold[]): string | null {
  if (holds.length === 0) return 'That booking no longer exists.'
  if (holds.some(h => h.source !== 'INTERNAL')) {
    return holds.some(h => h.source === 'SALESFORCE')
      ? 'This booking came from Salesforce; change it there.'
      : 'This booking was made in the client portal; it can only be changed with the client.'
  }
  // Committed = Closed Won: read-only in the app (closedWonRefusal).
  const won = closedWonRefusal(holds)
  if (won) return won
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

/**
 * The start dates that cap a booking's one expiry (lib/holdExpiry.ts
 * bookingHoldExpiry, lastExpiryDate): every hold that can still be held, so
 * not a committed one (it has no expiry) and not a market whose campaign has
 * already started. When none is left, every start. Pure.
 */
export function bookingCapStarts(rows: { start_date: string; status: string }[], today: string): string[] {
  const starts = rows.filter(r => r.status !== 'COMMITTED' && r.start_date.slice(0, 10) >= today).map(r => r.start_date.slice(0, 10))
  return starts.length ? starts : rows.map(r => r.start_date.slice(0, 10))
}

/**
 * What one expiry change in a booking's Edit dialog does to each hold. A
 * multi-market booking is one quote with one expiry, so every hold of the
 * card gets the chosen date (the dialog and the server keep it on or before
 * the booking's limit: lib/holdExpiry.ts lastExpiryDate). Holds that drifted
 * apart under the earlier per-market rule come back together on the next
 * edit. `changed` is false for a hold already on that date. Pure.
 */
export function expiryEdits(
  rows: { id: string; market: string; expires_at: string | null }[],
  chosen: string,
): { id: string; market: string; expiresOn: string; changed: boolean }[] {
  return rows.map(r => ({ id: r.id, market: r.market, expiresOn: chosen, changed: chosen !== (r.expires_at ? centralDate(new Date(r.expires_at)) : null) }))
}

/** The date (YYYY-MM-DD) the booking's soonest hold expires, as its card's badge shows: its Central day, as Salesforce's Hold Exp and the confirmation name it. */
export function earliestExpiryDate(rows: { expires_at: string | null }[]): string {
  const dates = rows.map(r => (r.expires_at ? centralDate(new Date(r.expires_at)) : null)).filter((d): d is string => !!d).sort()
  return dates[0] ?? ''
}

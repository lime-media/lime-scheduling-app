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
})[]): { markets: string[]; trucks: number; total: number | null; start: string; end: string; earliestExpiry: string | null } {
  const perGroup = new Map<string, number | null>()
  for (const r of rows) if (!perGroup.has(r.campaign_group_id ?? '')) perGroup.set(r.campaign_group_id ?? '', r.quoted_total)
  const totals = [...perGroup.values()]
  const expiries = rows.map(r => r.expires_at).filter((e): e is string => !!e).sort()
  return {
    markets: [...new Set(rows.map(r => r.market))],
    trucks: new Set(rows.map(r => r.truck_number)).size,
    total: totals.every(t => t === null) ? null : totals.reduce<number>((n, t) => n + (t ?? 0), 0),
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

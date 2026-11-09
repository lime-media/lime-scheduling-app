/**
 * A client's multi-market quote, the pure parts: the client rules a request
 * must meet, and what of a routed quote a client may see. The quote and the
 * booking themselves are lib/clientMultiMarket.ts.
 *
 * The rules are the single-market client rules (lib/clientAvailability.ts),
 * applied to every market: the lead time, at most CLIENT_MAX_TRUCKS trucks
 * (for the whole order: it is one booking), no 3-day weeks (the portal sells
 * Mon-Fri, Mon-Sat or every day). A client never sends coordinates, a rate,
 * a markup or a client type: markets are resolved and priced on the server.
 */

import { CLIENT_MAX_TRUCKS, daysUntil, MIN_CLIENT_LEAD_DAYS } from '@/lib/pricing'
import { isCalendarDate } from '@/lib/dateOnly'
import type { LineQuote, QuoteRequest, QuoteRow } from '@/lib/planning/quote'

/** The most markets in one client order. */
export const CLIENT_MAX_MARKETS = 10

const CLIENT_SCHEDULES = [5, 6, 7]

/**
 * How far out a client market may end, in days. Not a sales rule: the router
 * walks the fleet through the last end date, so a date decades out would
 * keep a client request busy for minutes.
 */
export const CLIENT_MAX_DAYS_AHEAD = 730

export type ClientPlanRequest = { rows: QuoteRow[]; features: QuoteRequest['features'] }

/**
 * The rows and features from untrusted input, by the client rules, or the
 * reason they're refused (safe to show the client). Pure (pass `today`).
 */
export function parseClientPlan(input: unknown, today = new Date()): ClientPlanRequest | { error: string } {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const raw = body.rows
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'Add at least one market.' }
  if (raw.length > CLIENT_MAX_MARKETS) return { error: `Up to ${CLIENT_MAX_MARKETS} markets can be booked online at once. Submit a request and the Lime Media team will work on a solution.` }
  const rows: QuoteRow[] = []
  const ids = new Set<string>()
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') return { error: 'Each market needs a name, dates and trucks.' }
    const { id, market, startDate, endDate, trucks } = r
    if (typeof id !== 'string' || !id || id.length > 64 || ids.has(id)) return { error: 'Each market needs its own id.' }
    ids.add(id)
    if (typeof market !== 'string' || !market.trim()) return { error: 'Each market needs a name.' }
    const name = market.trim()
    if (!isCalendarDate(startDate) || !isCalendarDate(endDate) || endDate < startDate) return { error: `Dates for ${name} must be a start and an end on or after it.` }
    if (daysUntil(endDate, today) > CLIENT_MAX_DAYS_AHEAD) return { error: `${name} ends more than 2 years out. Submit a request and the Lime Media team will work on a solution.` }
    if (typeof trucks !== 'number' || !Number.isInteger(trucks) || trucks < 1) return { error: `Trucks for ${name} must be a whole number, at least 1.` }
    const daysPerWeek = r.daysPerWeek ?? 5
    if (typeof daysPerWeek !== 'number' || !CLIENT_SCHEDULES.includes(daysPerWeek)) return { error: `Schedule for ${name} must be Mon-Fri, Mon-Sat or every day.` }
    const hours = r.hours ?? 8
    if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 8 || hours > 12) return { error: `Hours for ${name} must be 8 to 12.` }
    const lead = daysUntil(startDate, today)
    if (lead < MIN_CLIENT_LEAD_DAYS) {
      return { error: lead < 0
        ? `${name} starts on a date that has already passed.`
        : `${name} starts within ${MIN_CLIENT_LEAD_DAYS} days, which can't be booked online. Submit a request and the Lime Media team will see what's possible.` }
    }
    rows.push({ id, market: name, startDate, endDate, trucks, daysPerWeek, hours })
  }
  const total = rows.reduce((n, r) => n + r.trucks, 0)
  if (total > CLIENT_MAX_TRUCKS) return { error: `Up to ${CLIENT_MAX_TRUCKS} trucks can be booked online at once (this order has ${total}). Submit a request and the Lime Media team will work on a solution.` }

  const f = (body.features && typeof body.features === 'object' ? body.features : {}) as Record<string, unknown>
  for (const k of ['shadowFencing', 'smartDirectional', 'deviceId']) {
    if (f[k] !== undefined && typeof f[k] !== 'boolean') return { error: 'Features must be on or off.' }
  }
  return {
    rows,
    features: { shadowFencing: f.shadowFencing !== false, smartDirectional: f.smartDirectional === true, deviceId: f.deviceId === true },
  }
}

/**
 * One market of a quote as the client sees it: their dates, days and prices.
 * Nothing internal: no truck numbers, where trucks come from, transport we
 * absorb, or fleet counts. `missing` is how many of its trucks can't be
 * covered (a count, as the single-market quote's refusal gives).
 */
export function clientLine(l: LineQuote) {
  return {
    id: l.id,
    market: l.market,
    startDate: l.startDate,
    endDate: l.endDate,
    trucks: l.trucks,
    daysPerWeek: l.daysPerWeek,
    hours: l.hours,
    activationDays: l.activationDays,
    /** Truck-days billed, and asked for: fewer when a truck shares its week with another market. */
    truckDays: l.truckDays,
    requestedTruckDays: l.requestedTruckDays,
    firstDay: l.delivery.firstDay,
    lastDay: l.delivery.lastDay,
    dailyRate: l.effectiveDailyRate,
    baseMedia: l.baseMedia,
    shadowFencing: l.shadowFencing,
    smartDirectional: l.smartDirectional,
    deviceId: l.deviceId,
    media: l.media,
    transport: l.transport.billed,
    total: l.total,
    missing: l.missing,
  }
}

export type ClientLine = ReturnType<typeof clientLine>

/** Whether a routed order books exactly these trucks per market (row id). */
export const sameTrucks = (lines: { id: string; trucks: number }[], expected: Record<string, number>) =>
  lines.length === Object.keys(expected).length && lines.every(l => expected[l.id] === l.trucks)

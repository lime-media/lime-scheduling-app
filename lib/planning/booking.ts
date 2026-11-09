/**
 * Pure helpers for booking a multi-market quote: what each hold may show a
 * client, and text that must fit Salesforce fields. Kept apart from quote.ts
 * so they can be tested without the database.
 */

import type { QuoteFeatures } from '@/lib/quoteFeatures'
import { rotationStints, type OrderPlan, type Stint } from './order'
import type { LineQuote, QuoteRequest } from './quote'

/**
 * The client-facing breakdown for one market, in the QuoteFeatures shape the
 * hold pages render. A linked client sees this on each hold, so it carries
 * nothing internal: no truck origins, no transport we absorb, no fleet counts,
 * no other markets.
 */
export function lineFeatures(l: LineQuote, f: QuoteRequest['features'], brandMarkupPct = 0, clientType?: 'Agency' | 'Brand Direct' | null): QuoteFeatures {
  return {
    dailyRate: l.dailyRate,
    hourSurcharge: l.hourSurcharge,
    truckDays: l.truckDays,
    truckCount: l.trucks,
    activationDays: l.activationDays,
    calendarDays: l.calendarDays,
    daysPerWeek: l.daysPerWeek,
    operatingHours: l.hours,
    baseMedia: l.baseMedia,
    shadowFencing: f.shadowFencing ? l.shadowFencing : 0,
    shadowFencingFloored: l.shadowFencingFloored,
    smartDirectionalIncluded: f.smartDirectional,
    smartDirectional: l.smartDirectional,
    deviceIdIncluded: f.deviceId,
    deviceId: l.deviceId,
    transportCharge: l.transport.billed,
    requestedStart: l.startDate,
    requestedEnd: l.endDate,
    brandMarkupPct,
    ...(clientType ? { clientType } : {}),
  }
}

/** Semicolon-joined names that fit a text field, cut between names, never inside one. */
export function fitNames(names: string[], max: number): string {
  const out: string[] = []
  for (let i = 0; i < names.length; i++) {
    const rest = names.length - i - 1
    const next = [...out, names[i]].join('; ')
    if (next.length + (rest > 0 ? `; +${rest} more`.length : 0) > max) return `${out.join('; ')}; +${names.length - out.length} more`
    out.push(names[i])
  }
  return out.join('; ')
}

export const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
const scheduleText = (dpw: number) => (dpw === 3 ? '3 days/wk' : dpw === 7 ? 'every day' : dpw === 6 ? 'Mon-Sat' : 'Mon-Fri')

/** A booked market as delivered: real working dates and days, with the request when it differs. */
export function describeBooked(l: LineQuote, trucks = l.trucks): string {
  const d = l.delivery
  const base = `${l.market}: ${trucks} truck${trucks === 1 ? '' : 's'}, ${scheduleText(l.daysPerWeek)} x ${l.hours}h`
  if (!d.firstDay || !d.lastDay) return `${base}, requested ${l.startDate} to ${l.endDate}`
  const pw = d.partialWeek
  return `${base}, ${d.firstDay} to ${d.lastDay}`
    + (d.firstDay !== l.startDate || d.lastDay !== l.endDate ? ` (requested ${l.startDate} to ${l.endDate})` : '')
    + `, ${d.days} ${trucks > 1 ? 'truck-days' : 'days'}`
    + (pw ? ` (${d.fullWeeks} wk: ${d.fullWeekDays} + part-week ${pw.start} to ${pw.end}: ${pw.days})` : '')
}

/** A market quoted but not booked: the request as quoted. */
export const describeQuoted = (l: LineQuote, trucks = l.trucks) =>
  `${l.market}: ${trucks} truck${trucks === 1 ? '' : 's'}, ${l.startDate} to ${l.endDate}, ${scheduleText(l.daysPerWeek)} x ${l.hours}h`

/**
 * Every stretch a routed order holds: one per truck per job, or, for a truck
 * that alternates between two markets, one per stretch it spends in each
 * (rotationStints), with the market it alternates with.
 */
export function planStretches(plan: OrderPlan): { truckNumber: string; stint: Stint; partner: string | null }[] {
  return plan.trucks.flatMap(t => t.jobs.flatMap(job => rotationStints(job).map(st => ({
    truckNumber: t.truckNumber,
    stint: st,
    partner: job.lines.length > 1 ? job.lines.find(l => l.id !== st.lineId)!.market : null,
  }))))
}

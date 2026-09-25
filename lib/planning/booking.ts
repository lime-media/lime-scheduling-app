/**
 * Pure helpers for booking a multi-market quote: what each hold may show a
 * client, and text that must fit Salesforce fields. Kept apart from quote.ts
 * so they can be tested without the database.
 */

import type { QuoteFeatures } from '@/lib/quoteFeatures'
import type { LineQuote, QuoteRequest } from './quote'

/**
 * The client-facing breakdown for one market, in the QuoteFeatures shape the
 * hold pages render. A linked client sees this on each hold, so it carries
 * nothing internal: no truck origins, no transport we absorb, no fleet counts,
 * no other markets.
 */
export function lineFeatures(l: LineQuote, f: QuoteRequest['features']): QuoteFeatures {
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

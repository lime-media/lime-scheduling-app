/**
 * The Multi-market Plan's media options (shadow fencing, smart directional,
 * device ID passback), priced once for the whole order, as the single-market
 * quote prices them for all of its trucks (lib/pricing/engine.ts): a
 * multi-market booking is one quote, so the $5,000 shadow fencing minimum and
 * the device ID fee apply once, not once per market. Pure, so the planner page
 * can price the markets a rep selects exactly as the server will.
 */

import { optionRates, shadowFencingPrice, type OptionRates } from '@/lib/pricing/engine'
import { OPTION_LABELS } from '@/lib/quoteFeatures'

export { optionRates, type OptionRates }

export type OptionChoice = { shadowFencing: boolean; smartDirectional: boolean; deviceId: boolean }

/** What applyOptions needs of a priced market (lib/planning/quote.ts LineQuote). */
export type OptionLine = {
  market: string
  startDate: string
  truckDays: number
  baseMedia: number
  shadowFencing: number
  shadowFencingFloored: boolean
  smartDirectional: number
  deviceId: number
  optionsTotal: number
  media: number
  total: number
}

/** The order's options: each one's price across the order, chosen or not, and what is charged. */
export type OrderOptions = {
  chosen: OptionChoice
  rates: OptionRates
  /** Base media across the order: what shadow fencing is a share of. */
  baseMedia: number
  truckDays: number
  /** Each option's price for the order, chosen or not (a form shows it beside its switch). */
  prices: { shadowFencing: number; smartDirectional: number; deviceId: number }
  shadowFencingFloored: boolean
  /** What the chosen options add to the order. */
  total: number
  /** The market whose total carries the options' price. */
  carriedBy: string | null
}

/** A market's own price: its total less the order's options and studies it may carry (they're listed once for the whole order). Pure. */
export const marketOwnTotal = (l: { total: number; optionsTotal: number; studiesTotal: number }) => l.total - l.optionsTotal - l.studiesTotal

/** The market that carries an order-wide price (options, lift studies): the first by start, then by name. Pure. */
export function orderCarrier<L extends { startDate: string; market: string }>(lines: L[]): L | undefined {
  return [...lines].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.market.localeCompare(b.market))[0]
}

/**
 * The order's options, priced once on every market it routes: shadow fencing
 * is its share of the order's base media, never under its minimum; smart
 * directional is per truck-day across the order; device ID passback is one
 * flat fee. The price is carried on the first market (the one that carries
 * the lift studies: same order) so every total (the line, the booking,
 * Salesforce) adds up the same; every other market's options are 0. Lines
 * that already carry options have them taken off first, so this can price
 * any selection again.
 */
export function applyOptions<L extends OptionLine>(lines: L[], chosen: OptionChoice, rates: OptionRates): { lines: L[]; options: OrderOptions } {
  const clean = lines.map(l => (l.optionsTotal
    ? { ...l, media: l.media - l.optionsTotal, total: l.total - l.optionsTotal, optionsTotal: 0, shadowFencing: 0, shadowFencingFloored: false, smartDirectional: 0, deviceId: 0 }
    : l))
  const baseMedia = clean.reduce((s, l) => s + l.baseMedia, 0)
  const truckDays = clean.reduce((s, l) => s + l.truckDays, 0)
  const sfPrice = shadowFencingPrice(baseMedia, rates)
  const prices = {
    shadowFencing: clean.length ? Math.round(sfPrice.price) : 0,
    smartDirectional: Math.round(truckDays * rates.smartDirectionalDaily),
    deviceId: clean.length ? Math.round(rates.deviceIdFlat) : 0,
  }
  const sf = chosen.shadowFencing ? prices.shadowFencing : 0
  const sd = chosen.smartDirectional ? prices.smartDirectional : 0
  const did = chosen.deviceId ? prices.deviceId : 0
  const total = sf + sd + did
  const floored = chosen.shadowFencing && clean.length > 0 && sfPrice.floored
  const carrier = total > 0 ? orderCarrier(clean) : undefined
  return {
    lines: clean.map(l => (l === carrier
      ? { ...l, shadowFencing: sf, shadowFencingFloored: floored, smartDirectional: sd, deviceId: did, optionsTotal: total, media: l.media + total, total: l.total + total }
      : l)),
    options: { chosen: { ...chosen }, rates, baseMedia, truckDays, prices, shadowFencingFloored: floored, total, carriedBy: carrier?.market ?? null },
  }
}

/** The order's chosen options as line items, in the single-market quote's order and words (OPTION_LABELS, as QuoteBreakdown). Pure. */
export function optionItems(o: Pick<OrderOptions, 'chosen' | 'prices' | 'shadowFencingFloored' | 'rates'>): { label: string; amount: number }[] {
  const out: { label: string; amount: number }[] = []
  if (o.chosen.shadowFencing) out.push({ label: `${OPTION_LABELS.shadowFencing}${o.shadowFencingFloored ? ' (minimum applied)' : ` (${Number((o.rates.shadowFencingPct * 100).toFixed(1))}% of base media)`}`, amount: o.prices.shadowFencing })
  if (o.chosen.smartDirectional) out.push({ label: OPTION_LABELS.smartDirectional, amount: o.prices.smartDirectional })
  if (o.chosen.deviceId) out.push({ label: OPTION_LABELS.deviceId, amount: o.prices.deviceId })
  return out
}

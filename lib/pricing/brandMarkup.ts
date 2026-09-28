/**
 * Brand Direct markup — a premium on quotes for accounts Salesforce marks as
 * Brand Direct (Account.Client_Type2__c) rather than Agency.
 *
 * It applies to media (base media, features, studies), not to transport,
 * which is a pass-through cost. It starts at DEFAULT_BRAND_MARKUP_PCT and the
 * seller may change it, within 0-MAX_BRAND_MARKUP_PCT.
 */

export const DEFAULT_BRAND_MARKUP_PCT = 10
export const MAX_BRAND_MARKUP_PCT = 50

export type ClientType = 'Agency' | 'Brand Direct'

/** Salesforce leaves most accounts blank; blank means Agency (the picklist default). */
export function clientTypeOf(value: unknown): ClientType {
  return String(value ?? '').trim().toLowerCase() === 'brand direct' ? 'Brand Direct' : 'Agency'
}

/** A seller-entered percentage, kept to a sane range; missing or invalid means the default. */
export function clampBrandMarkup(pct: unknown): number {
  const n = typeof pct === 'number' ? pct : Number(pct)
  if (!Number.isFinite(n)) return DEFAULT_BRAND_MARKUP_PCT
  return Math.min(MAX_BRAND_MARKUP_PCT, Math.max(0, Math.round(n * 10) / 10))
}

/** The markup on a media amount, rounded to whole dollars. */
export function brandMarkupAmount(media: number, pct: number): number {
  return Math.round(media * (pct / 100))
}

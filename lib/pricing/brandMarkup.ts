/**
 * Brand Direct markup — a premium on quotes for accounts Salesforce marks as
 * Brand Direct (Account.Client_Type2__c) rather than Agency.
 *
 * It is FOLDED IN: every price is simply higher — the daily rate, hour
 * surcharge, features, studies and transport — through the pricing engine
 * (computeQuote / priceTransport `markupPct`). No markup line exists on any
 * quote, breakdown, hold or client-facing view. It starts at
 * DEFAULT_BRAND_MARKUP_PCT; sellers may change it (0-MAX_BRAND_MARKUP_PCT)
 * on internal quotes, and client self-quotes always use the default.
 */

export const DEFAULT_BRAND_MARKUP_PCT = 10
export const MAX_BRAND_MARKUP_PCT = 50

export type ClientType = 'Agency' | 'Brand Direct'

/** Salesforce leaves most accounts blank; blank means Agency (the picklist default). */
export function clientTypeOf(value: unknown): ClientType {
  return String(value ?? '').trim().toLowerCase() === 'brand direct' ? 'Brand Direct' : 'Agency'
}

/**
 * The seller's pick of client type on a quote (exactly Agency or Brand
 * Direct, as the Opportunity picklist has them), or null when none was sent
 * or it isn't one of those; callers then use the account's. Pure.
 */
export function chosenClientType(value: unknown): ClientType | null {
  return value === 'Agency' || value === 'Brand Direct' ? value : null
}

/** A seller-entered percentage, kept to a sane range; missing or invalid means the default. */
export function clampBrandMarkup(pct: unknown): number {
  const n = typeof pct === 'number' ? pct : Number(pct)
  if (!Number.isFinite(n)) return DEFAULT_BRAND_MARKUP_PCT
  return Math.min(MAX_BRAND_MARKUP_PCT, Math.max(0, Math.round(n * 10) / 10))
}

/** A price with the markup folded in (cents). The engine and routes all use this. */
export function withMarkup(price: number, pct: number): number {
  return pct ? Math.round(price * (1 + pct / 100) * 100) / 100 : price
}

/**
 * The markup a quote gets: the seller's (or the default) percentage for a
 * Brand Direct quote, nothing for an Agency one. The type is the seller's
 * pick on the quote (chosenClientType), else the Salesforce account's.
 */
export function brandMarkupFor(clientType: ClientType | null | undefined, requestedPct?: unknown): number {
  return clientType === 'Brand Direct' ? clampBrandMarkup(requestedPct ?? DEFAULT_BRAND_MARKUP_PCT) : 0
}

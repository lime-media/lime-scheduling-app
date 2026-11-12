/**
 * Lift study pricing, the one rule both quote tools use (the Quote Builder,
 * lib/pricing/engine.ts, and the Multi-market Plan, lib/planning/quote.ts).
 *
 * Decided 2026-11-11, following the vendor's cost shape (one study credit with
 * two exposure cuts included, then a charge per extra cut):
 * - Foot traffic and web lift: one study covers the whole order. The base
 *   ($7,500, or a rate card's `study_cost`) includes 2 unique markets; each
 *   further unique market adds $2,000.
 * - Brand lift: $12,500 flat.
 * - Sales lift: not priced. It's an ask: the team quotes it, so selecting it
 *   adds nothing to the total and flags the quote for follow-up.
 * - Studies cover up to 3 months. A longer order gets a warning to escalate,
 *   with no add-on price.
 * - Every study needs the order's estimated reach to meet STUDY_MIN_IMPRESSIONS.
 *
 * Pure.
 */

import { withMarkup } from './brandMarkup'
import { STUDY_PRICE, STUDY_MIN_IMPRESSIONS, VALID_STUDIES, type StudyType } from './config'

/** Unique markets the study base covers. */
export const STUDY_INCLUDED_MARKETS = 2
/** Each unique market beyond those (an extra exposure cut). */
export const STUDY_EXTRA_MARKET_PRICE = 2000
/** Brand lift survey, flat. */
export const BRAND_LIFT_PRICE = 12500
/** Studies that are an ask to the team, never a price. */
export const ASK_STUDIES: readonly StudyType[] = ['sales_lift']
/** The longest order a study covers, in calendar days (3 months). */
export const STUDY_WINDOW_DAYS = 92

export const STUDY_LONG_WARNING = 'Lift studies cover up to 3 months. This order runs longer, so check the study with the team before selling it.'
export const SALES_LIFT_ASK = 'Sales lift is quoted by the team: it adds nothing here, and the booking notes it for follow-up.'

export type StudiesQuote = {
  /** The order's estimated reach meets the minimum, so studies can be sold. */
  reachOk: boolean
  /** The selected studies that count (none when reach is short). */
  studies: StudyType[]
  /** What each study would cost on this order (sales lift: 0). */
  prices: Record<StudyType, number>
  /** The selected studies' total. */
  total: number
  /** Sales lift was selected: the team follows up with a price. */
  salesLiftRequested: boolean
  /** The order runs longer than a study covers. */
  warning: string | null
  uniqueMarkets: number
}

/**
 * Prices for one order. `base`: a rate card's study_cost, else the standard
 * $7,500; it replaces only the base, never the per-market charge or brand
 * lift. `markupPct`: the Brand Direct premium, folded into every price.
 */
export function priceStudies(input: {
  studies: readonly StudyType[]
  uniqueMarkets: number
  estimatedImpressions: number
  spanDays?: number
  base?: number | null
  markupPct?: number
}): StudiesQuote {
  const up = (n: number) => withMarkup(n, input.markupPct ?? 0)
  const markets = Math.max(1, Math.floor(input.uniqueMarkets) || 1)
  const extra = Math.max(0, markets - STUDY_INCLUDED_MARKETS) * STUDY_EXTRA_MARKET_PRICE
  const perOrder = up((input.base ?? STUDY_PRICE) + extra)
  const prices = Object.fromEntries(VALID_STUDIES.map(s => [s,
    ASK_STUDIES.includes(s) ? 0 : s === 'brand_lift' ? up(BRAND_LIFT_PRICE) : perOrder,
  ])) as Record<StudyType, number>
  const reachOk = input.estimatedImpressions >= STUDY_MIN_IMPRESSIONS
  const asked: readonly unknown[] = Array.isArray(input.studies) ? input.studies : []
  const studies = reachOk ? [...new Set(asked)].filter((s): s is StudyType => (VALID_STUDIES as readonly unknown[]).includes(s)) : []
  return {
    reachOk,
    studies,
    prices,
    total: studies.reduce((sum, s) => sum + prices[s], 0),
    salesLiftRequested: studies.some(s => ASK_STUDIES.includes(s)),
    warning: studies.length > 0 && (input.spanDays ?? 0) > STUDY_WINDOW_DAYS ? STUDY_LONG_WARNING : null,
    uniqueMarkets: markets,
  }
}

const marketKey = (m: string) => m.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Unique markets in an order: lines in the same market count once, and so do
 * markets one truck alternates between (`shared` pairs), which a study
 * measures as one exposure area. Pure.
 */
export function uniqueMarketCount(markets: readonly string[], shared: readonly (readonly [string, string])[] = []): number {
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    const p = parent.get(k) ?? k
    if (p === k) return k
    const root = find(p)
    parent.set(k, root)
    return root
  }
  for (const m of markets) if (marketKey(m)) parent.set(marketKey(m), parent.get(marketKey(m)) ?? marketKey(m))
  for (const [a, b] of shared) {
    const ka = marketKey(a), kb = marketKey(b)
    if (!parent.has(ka) || !parent.has(kb)) continue
    const ra = find(ka), rb = find(kb)
    if (ra !== rb) parent.set(ra, rb)
  }
  return Math.max(1, new Set([...parent.keys()].map(find)).size)
}

/** The selected studies' total at the given prices (a page's toggles). Pure. */
export function studiesCost(selected: readonly string[], prices: Partial<Record<string, number>>): number {
  return [...new Set(selected)].reduce((sum, s) => sum + (prices[s] ?? 0), 0)
}

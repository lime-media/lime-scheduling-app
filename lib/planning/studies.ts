/**
 * The Multi-market Plan's lift studies: one study per order, priced by the
 * rule both quote tools share (lib/pricing/studies.ts). Pure, so the planner
 * page can price the markets a rep selects exactly as the server will.
 */

import { STUDY_MIN_IMPRESSIONS, type StudyType } from '@/lib/pricing/config'
import { priceStudies, uniqueMarketCount, type StudiesQuote } from '@/lib/pricing/studies'
import { countCalendarDays } from '@/lib/pricing/schedule'

/** What applyStudies needs of a priced market (lib/planning/quote.ts LineQuote). */
export type StudyLine = {
  market: string
  studyMarket: string
  startDate: string
  endDate: string
  estimatedImpressions: number
  assigned: { sharedWith: string | null }[]
  studiesTotal: number
  media: number
  total: number
}

/** The order's lift studies: one study covers every market. */
export type OrderStudies = StudiesQuote & {
  estimatedImpressions: number
  reachMinimum: number
  spanDays: number
  /** The study base before any Brand Direct markup: the rate card's, else the standard one. */
  base: number | null
  /** The studies the rep asked for (some may not count: reach short), to price a selection of markets again. */
  requested: StudyType[]
  /** The market whose total carries the studies' price. */
  carriedBy: string | null
}

/**
 * The order's lift studies, priced once for the whole order on what is
 * actually routed: its total reach, its unique markets (a market booked twice,
 * or markets one truck alternates between, count once) and its span. The
 * price is carried on the first market so every total (the line, the
 * booking, Salesforce) adds up the same. Lines that already carry a studies
 * price have it taken off first, so this can price any selection again.
 */
export function applyStudies<L extends StudyLine>(
  lines: L[],
  studies: readonly StudyType[] | undefined,
  base: number | null | undefined,
  markupPct = 0,
): { lines: L[]; studies: OrderStudies } {
  const clean = lines.map(l => (l.studiesTotal ? { ...l, media: l.media - l.studiesTotal, total: l.total - l.studiesTotal, studiesTotal: 0 } : l))
  const keyOf = new Map(clean.map(l => [l.market, l.studyMarket]))
  const shared = clean.flatMap(l => l.assigned.filter(a => a.sharedWith).map(a => [l.studyMarket, keyOf.get(a.sharedWith!) ?? a.sharedWith!] as const))
  const estimatedImpressions = clean.reduce((s, l) => s + l.estimatedImpressions, 0)
  const start = clean.reduce((m, l) => (l.startDate < m ? l.startDate : m), clean[0]?.startDate ?? '')
  const end = clean.reduce((m, l) => (l.endDate > m ? l.endDate : m), clean[0]?.endDate ?? '')
  const spanDays = start && end ? countCalendarDays(start, end) : 0
  const st = priceStudies({ studies: studies ?? [], uniqueMarkets: uniqueMarketCount(clean.map(l => l.studyMarket), shared), estimatedImpressions, spanDays, base, markupPct })
  const total = Math.round(st.total)
  const carrier = total > 0 ? [...clean].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.market.localeCompare(b.market))[0] : undefined
  return {
    lines: clean.map(l => (l === carrier ? { ...l, studiesTotal: total, media: l.media + total, total: l.total + total } : l)),
    studies: { ...st, total, estimatedImpressions, reachMinimum: STUDY_MIN_IMPRESSIONS, spanDays, base: base ?? null, requested: [...new Set(studies ?? [])], carriedBy: carrier?.market ?? null },
  }
}

/** The markets a rep selected, priced as the server books them: the order's studies priced again for just those. Pure. */
export function selectionTotal<L extends StudyLine & { id: string }>(lines: L[], selected: ReadonlySet<string>, studies: Pick<OrderStudies, 'requested' | 'base'>, markupPct = 0): { total: number; studies: OrderStudies; carrierId: string | null } {
  const repriced = applyStudies(lines.filter(l => selected.has(l.id)), studies.requested, studies.base, markupPct)
  return {
    total: repriced.lines.reduce((n, l) => n + l.total, 0),
    studies: repriced.studies,
    carrierId: repriced.lines.find(l => l.studiesTotal > 0)?.id ?? null,
  }
}

/** What an alternative does to the order's lift studies, in words ('' when nothing changes). Pure. */
export function studiesChange(was: Pick<OrderStudies, 'total' | 'studies'>, now: Pick<OrderStudies, 'total' | 'studies'>): string {
  const money = (n: number) => '$' + Math.round(Math.abs(n)).toLocaleString('en-US')
  if (was.studies.length > 0 && now.studies.length === 0) return ` The lift studies drop out (${money(was.total)}): the order's reach falls under the minimum.`
  if (was.studies.length === 0 && now.studies.length > 0) return ` The lift studies come in (${money(now.total)}): the order's reach clears the minimum.`
  if (was.total !== now.total) return ` The lift studies cost ${money(now.total - was.total)} ${now.total < was.total ? 'less' : 'more'} (unique markets change).`
  return ''
}

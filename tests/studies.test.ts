/**
 * Lift study pricing (lib/pricing/studies.ts), the same in the Quote Builder
 * (lib/pricing/engine.ts) and the Multi-market Plan (lib/planning/studies.ts).
 * Run with: npm test
 */
import { eq, section } from './harness'
import { priceStudies, studiesCost, uniqueMarketCount, STUDY_LONG_WARNING } from '@/lib/pricing/studies'
import { computeQuote } from '@/lib/pricing/engine'
import { applyStudies, selectionTotal, studiesChange } from '@/lib/planning/studies'
import { bookedStudies } from '@/lib/bookings'
import { keepBookedPrices } from '@/lib/planning/quote'
import { planTier, studiesDescription } from '@/lib/planning/booking'

const REACH = 2_000_000
const price = (markets: number, o: Partial<Parameters<typeof priceStudies>[0]> = {}) =>
  priceStudies({ studies: ['foot_traffic', 'web_lift', 'brand_lift', 'sales_lift'], uniqueMarkets: markets, estimatedImpressions: REACH, ...o })

section('studies: foot traffic and web lift, one study per order')
eq('1 market: $7,500', price(1).prices.foot_traffic, 7500)
eq('2 markets: still $7,500 (2 included)', price(2).prices.foot_traffic, 7500)
eq('3 markets: +$2,000', price(3).prices.foot_traffic, 9500)
eq('5 markets: +$6,000', price(5).prices.foot_traffic, 13500)
eq('web lift follows the same rule', price(5).prices.web_lift, 13500)

section('studies: brand lift, sales lift')
eq('brand lift is $12,500 whatever the markets', [price(1).prices.brand_lift, price(5).prices.brand_lift], [12500, 12500])
eq('sales lift adds nothing', price(3).prices.sales_lift, 0)
eq('and is flagged for the team', price(3).salesLiftRequested, true)
eq('not flagged when not asked for', priceStudies({ studies: ['web_lift'], uniqueMarkets: 1, estimatedImpressions: REACH }).salesLiftRequested, false)
eq('all four on 3 markets: 9,500 + 9,500 + 12,500 + 0', price(3).total, 31500)

section('studies: the reach gate, on the whole order')
eq('below 1.2M: none count', [price(2, { estimatedImpressions: 1_199_999 }).studies, price(2, { estimatedImpressions: 1_199_999 }).total], [[], 0])
eq('at 1.2M: they count', price(2, { estimatedImpressions: 1_200_000 }).reachOk, true)
eq('a short reach flags no sales lift either', price(2, { estimatedImpressions: 10 }).salesLiftRequested, false)

section('studies: over 3 months')
eq('92 days: no warning', price(1, { spanDays: 92 }).warning, null)
eq('93 days: warn, no add-on', [price(1, { spanDays: 93 }).warning, price(1, { spanDays: 93 }).prices.foot_traffic], [STUDY_LONG_WARNING, 7500])
eq('no studies selected: no warning', priceStudies({ studies: [], uniqueMarkets: 1, estimatedImpressions: REACH, spanDays: 200 }).warning, null)

section('studies: a rate card replaces the base only')
eq('base 6,000 on 3 markets: 6,000 + 2,000', price(3, { base: 6000 }).prices.foot_traffic, 8000)
eq('brand lift keeps $12,500', price(3, { base: 6000 }).prices.brand_lift, 12500)
eq('Brand Direct markup on every price', [price(3, { markupPct: 10 }).prices.foot_traffic, price(3, { markupPct: 10 }).prices.brand_lift], [10450, 13750])

section('studies: unique markets')
eq('the same market twice counts once', uniqueMarketCount(['Dallas, TX', ' dallas,  tx', 'Austin, TX']), 2)
eq('markets one truck alternates between count once', uniqueMarketCount(['Dallas, TX', 'Fort Worth, TX', 'Austin, TX'], [['Dallas, TX', 'Fort Worth, TX']]), 2)
eq('a pair naming a market not in the order is ignored', uniqueMarketCount(['Dallas, TX'], [['Dallas, TX', 'Tulsa, OK']]), 1)
eq('never under 1', uniqueMarketCount([]), 1)
eq('a page sums its toggles at the quoted prices', studiesCost(['web_lift', 'web_lift', 'sales_lift'], { web_lift: 7500, sales_lift: 0 }), 7500)

section('studies: the Quote Builder engine')
const single = computeQuote({ truckCount: 2, days: 20, marketSizeTierId: 3, studies: ['foot_traffic', 'brand_lift', 'sales_lift'] })
eq('2 trucks x 20 days x 40,000 = 1.6M reach', single.best.estimatedImpressions, 1_600_000)
eq('foot traffic 7,500 + brand lift 12,500, sales lift asked', [single.best.studiesTotal, single.best.salesLiftRequested], [20000, true])
eq('Best adds the studies', single.best.total - single.best.betterTotal, 20000)
eq('one figure for the per-market studies', single.best.studyCost, 7500)
const small = computeQuote({ truckCount: 1, days: 10, marketSizeTierId: 4, studies: ['foot_traffic'] })
eq('200,000 reach: no studies priced', [small.best.studies, small.best.studiesTotal], [[], 0])
eq('a rate card study_cost is the base', computeQuote({ truckCount: 2, days: 20, studies: ['web_lift'], rateOverrides: { study_cost: 5000 } }).best.studiesTotal, 5000)

section('studies: the Multi-market Plan, one study for the order')
const line = (id: string, market: string, start: string, reach: number, o: Record<string, unknown> = {}) =>
  ({ id, market, studyMarket: market, startDate: start, endDate: '2026-12-31', estimatedImpressions: reach, assigned: [] as { sharedWith: string | null }[], studiesTotal: 0, media: 10000, total: 12000, ...o })
const order = [line('a', 'Austin, TX', '2026-11-16', 500_000), line('b', 'Dallas, TX', '2026-11-09', 500_000), line('c', 'Houston, TX', '2026-11-23', 500_000)]
const priced = applyStudies(order, ['foot_traffic'], null)
eq('reach is the order\'s total', priced.studies.estimatedImpressions, 1_500_000)
eq('3 markets: 9,500', priced.studies.total, 9500)
eq('carried on the first market by start', [priced.studies.carriedBy, priced.lines.map(l => l.studiesTotal)], ['Dallas, TX', [0, 9500, 0]])
eq('the order total includes it once', priced.lines.reduce((n, l) => n + l.total, 0), 36000 + 9500)
eq('pricing again changes nothing', applyStudies(priced.lines, ['foot_traffic'], null).lines.map(l => l.total), priced.lines.map(l => l.total))
const twice = applyStudies([...order, line('d', 'Dallas, TX', '2026-12-01', 500_000)], ['foot_traffic'], null)
eq('a market booked twice counts once', twice.studies.uniqueMarkets, 3)
eq('each market\'s own reach under the gate, the order\'s over it', applyStudies(order.slice(0, 2), ['foot_traffic'], null).studies.reachOk, false)
const sel = selectionTotal(priced.lines, new Set(['a', 'c']), priced.studies)
eq('a selection is priced again: 2 markets, 1.0M reach, no study', sel.total, 24000)
const selAll = selectionTotal(priced.lines, new Set(['a', 'b', 'c']), priced.studies)
eq('the whole order: as quoted', selAll.total, 45500)
const bigSel = selectionTotal(applyStudies(order.map(l => ({ ...l, estimatedImpressions: 900_000 })), ['web_lift'], null).lines, new Set(['a', 'c']), { requested: ['web_lift'], base: null })
eq('dropping the carrier moves the study to the next market', bigSel.total, 24000 + 7500)
eq('sales lift on the order: flagged, no price', applyStudies(order, ['sales_lift'], null).studies.salesLiftRequested, true)
eq('Brand Direct markup on the order\'s studies', applyStudies(order, ['foot_traffic'], 6000, 10).studies.total, 8800)

section('studies: a revision keeps a booked market\'s price without its old studies')
const keptLine = { id: 'r1', trucks: 1, total: 50000, media: 50000, missing: 0, transport: { outcome: 'INCLUDED', billed: 0, absorbedCost: 0 },
  dailyRate: 1300, hourSurcharge: 0, baseMedia: 40000, shadowFencing: 0, smartDirectional: 0, deviceId: 0, studiesTotal: 0,
  assigned: [{ truckNumber: '0382', sharedWith: null, hopRoadMiles: 0 }] } as never
const keptWithStudies = new Map([['r1', { total: 47500, features: JSON.stringify({ transportCharge: 0, baseMedia: 40000, studiesTotal: 7500 }), trucks: ['0382'], truckCount: 1, markupPct: 0 as number | null }]])
const [k] = keepBookedPrices([keptLine], keptWithStudies) as unknown as { total: number; media: number }[]
eq('the booked total less the studies it carried (priced again for the order)', [k.total, k.media], [40000, 40000])

section('studies: tier and Salesforce text')
eq('shadow fencing + studies is Best', planTier({ shadowFencing: true, smartDirectional: false, deviceId: false }, ['web_lift']), 'Best')
eq('shadow fencing alone is Better', planTier({ shadowFencing: true, smartDirectional: false, deviceId: false }), 'Better')
eq('no options is Good', planTier({ shadowFencing: false, smartDirectional: false, deviceId: false }), 'Good')
eq('the Description names the studies and the ask',
  studiesDescription({ studies: ['foot_traffic', 'sales_lift'], prices: price(3).prices, total: 9500, uniqueMarkets: 3, salesLiftRequested: true, warning: null }),
  ['', 'Lift studies for the whole order (3 unique markets): foot traffic $9,500; $9,500 in all.', 'Sales lift requested: the team quotes it.'])
eq('no studies: no lines', studiesDescription({ studies: [], prices: price(1).prices, total: 0, uniqueMarkets: 1, salesLiftRequested: false, warning: null }), [])

section('studies: a revision restores only what was sold')
const f = (o: Record<string, unknown>) => ({ features: JSON.stringify(o) })
eq('priced studies come back', bookedStudies([f({ studies: ['foot_traffic', 'brand_lift'], studiesTotal: 20000 })]), ['foot_traffic', 'brand_lift'])
eq('an older booking that recorded studies it never sold (reach short, $0): none', bookedStudies([f({ studies: ['foot_traffic'], studiesTotal: 0 })]), [])
eq('no studiesTotal recorded: none', bookedStudies([f({ studies: ['web_lift'] })]), [])
eq('a multi-market booking: found on the market that carried them', bookedStudies([f({ studies: ['web_lift'], studiesTotal: 0 }), f({ studies: ['web_lift'], studiesTotal: 7500 })]), ['web_lift'])
eq('a sales lift ask alone comes back', bookedStudies([f({ studies: ['sales_lift'], studiesTotal: 0, salesLiftRequested: true })]), ['sales_lift'])
eq('nothing recorded: none', bookedStudies([f({}), { features: null }]), [])

section('studies: alternatives say what they do to the studies')
const was = { total: 20000, studies: ['foot_traffic', 'brand_lift'] as never[] }
eq('reach falls under the minimum', studiesChange(was, { total: 0, studies: [] }), ' The lift studies drop out ($20,000): the order\'s reach falls under the minimum.')
eq('reach clears it', studiesChange({ total: 0, studies: [] }, was), ' The lift studies come in ($20,000): the order\'s reach clears the minimum.')
eq('fewer unique markets', studiesChange(was, { total: 18000, studies: was.studies }), ' The lift studies cost $2,000 less (unique markets change).')
eq('no change: nothing said', studiesChange(was, was), '')

section('studies: the selection names its own carrier')
const s3 = applyStudies(order.map(l => ({ ...l, estimatedImpressions: 900_000 })), ['web_lift'], null)
eq('whole order: the earliest market carries it', selectionTotal(s3.lines, new Set(['a', 'b', 'c']), s3.studies).carrierId, 'b')
eq('without it: the next earliest', selectionTotal(s3.lines, new Set(['a', 'c']), s3.studies).carrierId, 'a')
eq('and the selection\'s own unique markets', selectionTotal(s3.lines, new Set(['a', 'c']), s3.studies).studies.uniqueMarkets, 2)
eq('under the minimum: no carrier', selectionTotal(s3.lines, new Set(['c']), s3.studies).carrierId, null)

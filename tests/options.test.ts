/**
 * The Multi-market Plan's media options (lib/planning/options.ts): shadow
 * fencing, smart directional and device ID passback priced once for the whole
 * order, as the single-market quote prices them for all of its trucks.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { applyOptions, optionItems, optionRates } from '@/lib/planning/options'
import { selectionTotal } from '@/lib/planning/studies'
import { lineFeatures } from '@/lib/planning/booking'
import { reviseRows, type RevisableHold } from '@/lib/bookings'
import { computeQuote } from '@/lib/pricing/engine'

const line = (id: string, market: string, start: string, base: number, truckDays = 20) => ({
  id, market, studyMarket: market, startDate: start, endDate: '2026-12-31', estimatedImpressions: 100_000, assigned: [] as { sharedWith: string | null }[],
  truckDays, baseMedia: base, shadowFencing: 0, shadowFencingFloored: false, smartDirectional: 0, deviceId: 0, optionsTotal: 0, studiesTotal: 0,
  media: base, total: base + 1000, transport: { outcome: 'BILLED', billed: 1000, absorbedCost: 0 },
})
const ALL = { shadowFencing: true, smartDirectional: true, deviceId: true }
const SF = { shadowFencing: true, smartDirectional: false, deviceId: false }
const NONE = { shadowFencing: false, smartDirectional: false, deviceId: false }
const rates = optionRates(null)
const total = (ls: { total: number }[]) => ls.reduce((n, l) => n + l.total, 0)

section('options: shadow fencing is one charge for the order')
{
  const big = [line('a', 'Austin, TX', '2026-11-16', 12000), line('b', 'Dallas, TX', '2026-11-09', 12000), line('c', 'Houston, TX', '2026-11-23', 12000)]
  const p = applyOptions(big, SF, rates)
  eq('25% of the order\'s base media', p.options.prices.shadowFencing, 9000)
  eq('over the minimum: not floored', p.options.shadowFencingFloored, false)
  eq('carried on the first market by start, 0 elsewhere', [p.options.carriedBy, p.lines.map(l => l.shadowFencing)], ['Dallas, TX', [0, 9000, 0]])
  eq('the order total includes it once', total(p.lines), 39000 + 9000)
  eq('pricing again changes nothing', applyOptions(p.lines, SF, rates).lines.map(l => l.total), p.lines.map(l => l.total))

  const small = [line('a', 'Austin, TX', '2026-11-16', 6000), line('b', 'Dallas, TX', '2026-11-09', 6000)]
  const s = applyOptions(small, SF, rates)
  eq('under $20,000 of base media: the $5,000 minimum, once (not $5,000 per market)', [s.options.prices.shadowFencing, s.options.total, s.options.shadowFencingFloored], [5000, 5000, true])
  eq('the floored market says so', s.lines.find(l => l.shadowFencing > 0)!.shadowFencingFloored, true)
  eq('same as the single-market quote for the same base media', s.options.prices.shadowFencing, computeQuote({ truckCount: 1, days: 1, rateOverrides: { daily_rates: { '1_1': 12000 } } }).better.shadowFencing)
}

section('options: smart directional and device ID')
{
  const ls = [line('a', 'Austin, TX', '2026-11-16', 30000, 20), line('b', 'Dallas, TX', '2026-11-09', 30000, 15)]
  const p = applyOptions(ls, ALL, rates)
  eq('smart directional: $250 per truck-day across the order', p.options.prices.smartDirectional, 250 * 35)
  eq('device ID passback: one flat fee for the order', p.options.prices.deviceId, 2500)
  eq('every option on the one market', p.lines.map(l => [l.shadowFencing, l.smartDirectional, l.deviceId]), [[0, 0, 0], [15000, 8750, 2500]])
  eq('optionsTotal is what they add', p.lines[1].optionsTotal, 15000 + 8750 + 2500)
  eq('line items, in the single quote\'s order and words', optionItems(p.options), [
    { label: 'Shadow fencing (25% of base media)', amount: 15000 },
    { label: 'Smart directional (35 truck-days)', amount: 8750 },
    { label: 'Device ID passback', amount: 2500 },
  ])
  const off = applyOptions(ls, NONE, rates)
  eq('nothing chosen: nothing charged or carried', [off.options.total, off.options.carriedBy, total(off.lines)], [0, null, total(ls)])
  eq('but every option still has its price (for a form)', off.options.prices, { shadowFencing: 15000, smartDirectional: 8750, deviceId: 2500 })
  eq('nothing chosen: no line items', optionItems(off.options), [])
  eq('turning options off takes them back off', total(applyOptions(p.lines, NONE, rates).lines), total(ls))
}

section('options: rate cards and Brand Direct')
{
  const ls = [line('a', 'Austin, TX', '2026-11-16', 4000)]
  eq('a rate card\'s floor and share are used', applyOptions(ls, SF, optionRates({ shadow_fencing_floor: 3000, shadow_fencing_pct: 0.5 })).options.prices.shadowFencing, 3000)
  eq('Brand Direct markup is folded into the floor', applyOptions(ls, SF, optionRates(null, 10)).options.prices.shadowFencing, 5500)
  eq('and into device ID', applyOptions(ls, { ...NONE, deviceId: true }, optionRates(null, 10)).options.prices.deviceId, 2750)
  eq('a rate card\'s device ID fee', applyOptions(ls, { ...NONE, deviceId: true }, optionRates({ device_id_flat: 1000 })).options.prices.deviceId, 1000)
}

section('options: a selection is priced again')
{
  const order = [line('a', 'Austin, TX', '2026-11-16', 12000), line('b', 'Dallas, TX', '2026-11-09', 12000), line('c', 'Houston, TX', '2026-11-23', 12000)]
  const p = applyOptions(order, SF, rates)
  const studies = { requested: [], base: null }
  const sel = selectionTotal(p.lines, new Set(['a', 'c']), studies, p.options)
  eq('two markets: the minimum, once', [sel.options.prices.shadowFencing, sel.options.carriedBy], [6000, 'Austin, TX'])
  eq('the total is the selection\'s own', sel.total, 26000 + 6000)
  eq('one small market: still the minimum', selectionTotal(p.lines, new Set(['c']), studies, p.options).options.prices.shadowFencing, 5000)
  eq('the whole order: as quoted', selectionTotal(p.lines, new Set(['a', 'b', 'c']), studies, p.options).total, total(p.lines))
}

section('options: what each hold records, and what a revision reads back')
{
  const p = applyOptions([line('a', 'Austin, TX', '2026-11-16', 12000), line('b', 'Dallas, TX', '2026-11-09', 12000)], SF, rates)
  const asFeatures = (l: typeof p.lines[number]) => JSON.stringify(lineFeatures(l as never, { ...SF }))
  const carrier = asFeatures(p.lines[1])
  const other = asFeatures(p.lines[0])
  eq('the carrying market\'s holds carry the amount', JSON.parse(carrier).shadowFencing, 6000)
  eq('the others: none, but chosen', [JSON.parse(other).shadowFencing, JSON.parse(other).shadowFencingIncluded], [0, true])
  const hold = (id: string, features: string): RevisableHold => ({
    id, campaign_group_id: `mm_x_${id}`, sfdc_opportunity_id: null, truck_number: '0100', market: 'Austin, TX', start_date: '2026-11-16', end_date: '2026-12-31',
    status: 'HOLD', source: 'INTERNAL', origination: 'frontend', features, truck_count: 1, live: true,
  }) as RevisableHold
  eq('a revision restores shadow fencing from a market that doesn\'t carry it', reviseRows([hold('1', other), hold('2', carrier)]).features.shadowFencing, true)
  eq('older single-market holds (amount only) still read as chosen', reviseRows([hold('1', JSON.stringify({ shadowFencing: 5000 }))]).features.shadowFencing, true)
  eq('none chosen: none restored', reviseRows([hold('1', JSON.stringify({ shadowFencing: 0, shadowFencingIncluded: false }))]).features.shadowFencing, false)
}

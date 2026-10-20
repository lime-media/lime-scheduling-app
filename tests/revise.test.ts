/**
 * Evolving a deal without new opportunities: revising a booking in the planner
 * (lib/bookings.ts, lib/planning/order.ts keepTrucks) and adding a quote to an
 * existing opportunity (lib/opportunityMerge.ts).
 * Run with: npm test
 */
import { eq, section } from './harness'
import { keptPrices, reviseRefusal, reviseRows, type RevisableHold } from '@/lib/bookings'
import { keepBookedPrices } from '@/lib/planning/quote'
import { mergedOpportunityFields, type LinkedHold } from '@/lib/opportunityMerge'
import { planOrder, DEFAULT_ENGINE, type OrderLine } from '@/lib/planning/order'
import type { PlanTruck } from '@/lib/planning/planner'

const feat = (o: Record<string, unknown> = {}) => JSON.stringify({ daysPerWeek: 5, operatingHours: 10, truckCount: 2, shadowFencing: 5000, smartDirectionalIncluded: false, deviceIdIncluded: true, ...o })
const hold = (o: Partial<RevisableHold> = {}): RevisableHold => ({
  id: 'h1', campaign_group_id: 'mm_abc_1', sfdc_opportunity_id: '006X', truck_number: '0382', market: 'Albany, NY',
  start_date: '2026-11-09', end_date: '2026-12-04', status: 'HOLD', source: 'INTERNAL', origination: 'frontend',
  features: feat(), truck_count: 2, live: true, ...o,
})

section('revise: what can be revised')
eq('a quote-tool booking', reviseRefusal([hold()]), null)
eq('gone', reviseRefusal([]), 'That booking no longer exists.')
eq('a Salesforce push is changed in Salesforce', reviseRefusal([hold({ source: 'SALESFORCE' })]), 'This booking came from Salesforce; change it there.')
eq('a client booking is the client\'s', reviseRefusal([hold({ source: 'CLIENT' })])?.startsWith('This booking was made in the client portal'), true)
eq('a pending extension request: refused until it is answered', reviseRefusal([hold(), hold({ id: 'h2', status: 'EXTENSION_REQUESTED' })])?.startsWith('This booking has an extension request waiting'), true)
eq('lift studies would be dropped: refused', reviseRefusal([hold({ features: feat({ studies: ['web_lift'] }) })])?.includes('lift studies'), true)

section('revise: the booking as planner rows')
const booking = [
  hold({ id: 'a1', truck_number: '0382' }),
  hold({ id: 'a2', truck_number: '0912', start_date: '2026-11-10', end_date: '2026-12-06' }),
  hold({ id: 'b1', campaign_group_id: 'mm_abc_2', market: 'Buffalo, NY', truck_number: '4840', truck_count: 1, features: feat({ daysPerWeek: 7, operatingHours: 8 }) }),
]
const r = reviseRows(booking)
eq('one row per market', r.rows.map(x => x.market), ['Albany, NY', 'Buffalo, NY'])
eq('dates span the market\'s holds', [r.rows[0].startDate, r.rows[0].endDate], ['2026-11-09', '2026-12-06'])
eq('trucks, schedule and hours as booked', r.rows.map(x => [x.trucks, x.daysPerWeek, x.hours]), [[2, 5, 10], [1, 7, 8]])
eq('options as booked', r.features, { shadowFencing: true, smartDirectional: false, deviceId: true })
eq('live: each market keeps its trucks', r.rows.map(x => x.keepTrucks), [['0382', '0912'], ['4840']])
const expired = reviseRows(booking.map(h => ({ ...h, live: false, status: 'EXPIRED' })))
eq('expired: nothing kept, re-picked and re-priced', [expired.live, expired.rows.every(x => x.keepTrucks.length === 0)], [false, true])
eq('quote-only logs are recognized', reviseRows([hold({ origination: 'quote_only', status: 'EXPIRED', live: false, truck_number: 'UNASSIGNED' })]).quoteOnly, true)
eq('quote-only placeholder truck is never "kept"',
  reviseRows([hold({ origination: 'quote_only', truck_number: 'UNASSIGNED' })]).rows[0].keepTrucks, [])

section('revise: a market keeps its truck where it still fits')
const S = { ...DEFAULT_ENGINE, today: '2026-10-16' }
const dallas = { lat: 32.78, lng: -96.80 }
const line = (keepTrucks?: string[]): OrderLine => ({ id: 'L1', market: 'Dallas', ...dallas, startDate: '2026-11-09', endDate: '2026-11-20', trucks: 1, daysPerWeek: 5, hours: 8, keepTrucks })
const at = (n: string, lat: number, lng: number): PlanTruck => ({ truckNumber: n, jobs: [], gps: { lat, lng }, gpsLabel: n })
const fleet = [at('NEAR', 32.80, -96.79), at('KEPT', 30.27, -97.74) /* Austin, ~180 mi */]
eq('without a revision, the nearest truck wins', planOrder([line()], fleet, S).trucks.map(t => t.truckNumber), ['NEAR'])
eq('revising, the truck it already holds is kept', planOrder([line(['KEPT'])], fleet, S).trucks.map(t => t.truckNumber), ['KEPT'])
const busyKept: PlanTruck = { ...at('KEPT', 30.27, -97.74), jobs: [{ start: '2026-11-12', end: '2026-11-14', market: 'Austin', state: 'TX', lat: 30.27, lng: -97.74, source: 'SCHEDULE', yieldable: false }] }
eq('but not where it no longer fits (now busy on the new dates)', planOrder([line(['KEPT'])], [fleet[0], busyKept], S).trucks.map(t => t.truckNumber), ['NEAR'])

section('opportunity: adding a quote to an existing one')
const existing = {
  Amount: 210000, Markets__c: 'Albany, NY; Buffalo, NY', LED_Trucks__c: 'LED-0382;LED-4840',
  LED_Hold_Start__c: '2026-11-09', LED_Hold_Stop__c: '2026-12-04', LED_Hold_Exp__c: '2026-10-30', Description: 'Booked: …',
}
const lh = (truck: string, market: string, start: string, end: string, expires: string | null, fromSalesforce = false): LinkedHold =>
  ({ truck, market, start, end, expires, fromSalesforce })
// The holds reserving trucks on the opportunity once the quote is added.
const albany = lh('0382', 'Albany, NY', '2026-11-09', '2026-12-04', '2026-10-30')
const buffalo = lh('4840', 'Buffalo, NY', '2026-11-09', '2026-12-04', '2026-10-30')
const providence = lh('0912', 'Providence, RI', '2026-11-02', '2026-11-20', '2026-10-28')
const note = { date: '2026-10-16', by: 'Madison' }
const added = mergedOpportunityFields('ADD', existing,
  { amount: 30000, markets: ['Providence, RI'], trucks: ['0912'], holdStart: '2026-11-02', holdStop: '2026-11-20', holdExp: '2026-10-28', description: 'Providence, RI: 1 truck' },
  note, [albany, buffalo, providence])
const add = added.fields
eq('amount adds', add.Amount, 240000)
eq('markets and trucks are the union', [add.Markets__c, add.LED_Trucks__c], ['Albany, NY; Buffalo, NY; Providence, RI', 'LED-0382;LED-4840;LED-0912'])
eq('the hold window covers every reserving hold', [add.LED_Hold_Start__c, add.LED_Hold_Stop__c, added.windowLeft], ['2026-11-02', '2026-12-04', false])
eq('the earliest expiry still to come', add.LED_Hold_Exp__c, '2026-10-28')
eq('the description keeps the old and says what was added',
  String(add.Description).startsWith('Booked: …\n\nAdded 2026-10-16 by Madison ($30,000):\nProvidence'), true)
const addQuoteOnly = mergedOpportunityFields('ADD', existing, { amount: 5000, markets: ['Boston, MA'], trucks: [], description: 'Boston quote' }, note, [albany, buffalo]).fields
eq('a quote-only addition sets no LED hold fields', ['LED_Trucks__c', 'LED_Hold_Start__c', 'LED_Hold_Exp__c'].some(k => k in addQuoteOnly), false)
eq('an expiry already past does not win',
  mergedOpportunityFields('ADD', existing, { amount: 1, markets: [], trucks: ['0912'], holdStart: '2026-11-02', holdStop: '2026-11-20', holdExp: '2026-10-28', description: '' },
    note, [{ ...albany, expires: '2026-10-01' }, providence]).fields.LED_Hold_Exp__c, '2026-10-28')
{
  // Salesforce reserved 4840 itself: widening the window would re-date it to the app's dates.
  const sf = mergedOpportunityFields('ADD', existing,
    { amount: 30000, markets: ['Providence, RI'], trucks: ['0912'], holdStart: '2026-11-02', holdStop: '2026-11-20', holdExp: '2026-10-28', description: '' },
    note, [albany, { ...buffalo, fromSalesforce: true }, providence])
  eq('a truck Salesforce reserved: window and expiry left alone, trucks still listed',
    [sf.windowLeft, 'LED_Hold_Start__c' in sf.fields, 'LED_Hold_Stop__c' in sf.fields, 'LED_Hold_Exp__c' in sf.fields, sf.fields.LED_Trucks__c],
    [true, false, false, false, 'LED-0382;LED-4840;LED-0912'])
}

eq('a listed truck no longer held is dropped, not re-reserved over the new dates',
  mergedOpportunityFields('ADD', existing, { amount: 1, markets: [], trucks: ['0912'], holdStart: '2026-11-02', holdStop: '2026-11-20', holdExp: '2026-10-28', description: '' },
    note, [albany, providence]).fields.LED_Trucks__c, 'LED-0382;LED-0912')

section('opportunity: a revision replaces only its own booking on it')
{
  const was = { amount: 210000, markets: ['Albany, NY', 'Buffalo, NY'] }
  const newAlbany = lh('0382', 'Albany, NY', '2026-11-16', '2026-12-04', '2026-11-01')
  const rep = mergedOpportunityFields('REPLACE', existing,
    { amount: 180000, markets: ['Albany, NY'], trucks: ['0382'], holdStart: '2026-11-16', holdStop: '2026-12-04', holdExp: '2026-11-01', description: 'Booked: Albany' },
    { date: '2026-10-16', by: 'Bryce' }, [newAlbany], was).fields
  eq('figures are the booking as it now stands', [rep.Amount, rep.Markets__c, rep.LED_Trucks__c, rep.LED_Hold_Start__c], [180000, 'Albany, NY', 'LED-0382', '2026-11-16'])
  eq('the revision note says what it was', String(rep.Description).startsWith('Revised 2026-10-16 by Bryce. Was: amount $210,000; markets Albany, NY; Buffalo, NY; 2026-11-09 to 2026-12-04.'), true)
  eq('the old description is kept below it', String(rep.Description).endsWith('\n\nBefore this revision:\nBooked: …'), true)

  // Providence was added to the same opportunity ($30,000); revising the Albany/Buffalo booking must not drop it.
  const shared = { ...existing, Amount: 240000, Markets__c: 'Albany, NY; Buffalo, NY; Providence, RI', LED_Trucks__c: 'LED-0382;LED-4840;LED-0912' }
  const rev = mergedOpportunityFields('REPLACE', shared,
    { amount: 180000, markets: ['Albany, NY'], trucks: ['0382'], holdStart: '2026-11-16', holdStop: '2026-12-04', holdExp: '2026-11-01', description: '' },
    { date: '2026-10-16', by: 'Bryce' }, [newAlbany, providence], was).fields
  eq('another booking on the opportunity keeps its amount, market and truck',
    [rev.Amount, rev.Markets__c, rev.LED_Trucks__c, rev.LED_Hold_Start__c], [210000, 'Albany, NY; Providence, RI', 'LED-0382;LED-0912', '2026-11-02'])

  // Revised into a quote-only log: nothing reserves a truck any more.
  const qo = mergedOpportunityFields('REPLACE', existing, { amount: 180000, markets: ['Albany, NY'], trucks: [], description: '' },
    { date: '2026-10-16', by: 'Bryce' }, [], was).fields
  eq('revised to quote only: the LED trucks and hold dates are cleared',
    [qo.LED_Trucks__c, qo.LED_Hold_Start__c, qo.LED_Hold_Stop__c, qo.LED_Hold_Exp__c], [null, null, null, null])
  eq('an unpriced old booking: the new amount stands alone',
    mergedOpportunityFields('REPLACE', existing, { amount: 180000, markets: [], trucks: [], description: '' }, note, [], { amount: null, markets: [] }).fields.Amount, 180000)
}

section('revise: unchanged markets keep their booked price')
{
  const booked = [
    { ...hold({ id: 'a1', truck_number: '0382' }), quoted_total: 42000 },
    { ...hold({ id: 'a2', truck_number: '0912' }), quoted_total: 42000 },
    { ...hold({ id: 'b1', campaign_group_id: 'mm_abc_2', market: 'Buffalo, NY', truck_number: '4840', truck_count: 1 }), quoted_total: 21000 },
  ]
  const opts = { shadowFencing: true, smartDirectional: false, deviceId: true }
  const asBooked = [
    { id: 'r1', market: 'Albany, NY', startDate: '2026-11-09', endDate: '2026-12-04', trucks: 2, daysPerWeek: 5, hours: 10 },
    { id: 'r2', market: 'Buffalo, NY', startDate: '2026-11-09', endDate: '2026-12-04', trucks: 1, daysPerWeek: 5, hours: 10 },
  ]
  eq('unchanged markets keep their price', [...keptPrices(booked, asBooked, opts)].map(([id, k]) => [id, k.total]), [['r1', 42000], ['r2', 21000]])
  const moved = [{ ...asBooked[0], endDate: '2026-12-11' }, asBooked[1]]
  eq('a market whose dates moved is priced today', [...keptPrices(booked, moved, opts).keys()], ['r2'])
  eq('a new market is priced today', [...keptPrices(booked, [...asBooked, { ...asBooked[1], id: 'r3', market: 'Boston, MA' }], opts).keys()], ['r1', 'r2'])
  eq('changing the options reprices every market', keptPrices(booked, asBooked, { ...opts, deviceId: false }).size, 0)
  eq('an expired booking keeps no prices', keptPrices(booked.map(h => ({ ...h, live: false })), asBooked, opts).size, 0)

  const line = (o: Record<string, unknown>) => ({ id: 'r1', trucks: 2, total: 50000, media: 47000, missing: 0, transport: { outcome: 'BILLED', billed: 3000, absorbedCost: 0 },
    dailyRate: 1300, hourSurcharge: 0, baseMedia: 40000, shadowFencing: 7000, smartDirectional: 0, deviceId: 0,
    assigned: [{ truckNumber: '0382', sharedWith: null, hopRoadMiles: 0 }, { truckNumber: '0912', sharedWith: null, hopRoadMiles: 0 }], ...o }) as never
  const kept = new Map([['r1', { total: 42000, features: JSON.stringify({ transportCharge: 0, baseMedia: 36000, shadowFencing: 6000 }), trucks: ['0382', '0912'], truckCount: 2, markupPct: 0 as number | null }]])
  const [l] = keepBookedPrices([line({})], kept) as unknown as { total: number; media: number; priceKept: boolean; transport: { billed: number } }[]
  eq('the booked price and its breakdown replace today\'s', [l.total, l.media, l.transport.billed, l.priceKept], [42000, 42000, 0, true])
  const [swapped] = keepBookedPrices([line({ assigned: [{ truckNumber: '7777', sharedWith: null, hopRoadMiles: 0 }] })], kept) as unknown as { total: number; priceKept?: boolean }[]
  eq('a market that lost its trucks is priced today', [swapped.total, swapped.priceKept ?? false], [50000, false])
  const [partial] = keepBookedPrices([line({ trucks: 1, assigned: [{ truckNumber: '0382', sharedWith: null, hopRoadMiles: 0 }] })], kept) as unknown as { total: number; priceKept?: boolean }[]
  const [sameMarkup] = keepBookedPrices([line({})], kept, 0) as unknown as { total: number }[]
  eq('the same Brand Direct markup keeps the price', sameMarkup.total, 42000)
  const [newMarkup] = keepBookedPrices([line({})], kept, 10) as unknown as { total: number; priceKept?: boolean }[]
  eq('a changed markup reprices the market', [newMarkup.total, newMarkup.priceKept ?? false], [50000, false])
  const unknown = new Map([['r1', { ...kept.get('r1')!, markupPct: null }]])
  eq('holds booked before the markup was recorded: kept as before', (keepBookedPrices([line({})], unknown, 10) as unknown as { total: number }[])[0].total, 42000)
  eq('a partial booking that dropped a truck is priced today, not at the 2-truck price', [partial.total, partial.priceKept ?? false], [50000, false])

  // Dallas booked twice: March ($30,000) and June ($45,000).
  const twice = [
    { ...hold({ id: 'm1', campaign_group_id: 'mm_abc_1', market: 'Dallas, TX', truck_number: '0100', truck_count: 1, start_date: '2026-03-02', end_date: '2026-03-27' }), quoted_total: 30000 },
    { ...hold({ id: 'j1', campaign_group_id: 'mm_abc_2', market: 'Dallas, TX', truck_number: '0200', truck_count: 1, start_date: '2026-06-01', end_date: '2026-06-26' }), quoted_total: 45000 },
  ]
  const flights = [
    { id: 'june', market: 'Dallas, TX', startDate: '2026-06-01', endDate: '2026-06-26', trucks: 1, daysPerWeek: 5, hours: 10 },
    { id: 'march', market: 'Dallas, TX', startDate: '2026-03-02', endDate: '2026-03-27', trucks: 1, daysPerWeek: 5, hours: 10 },
  ]
  eq('the same market twice: each flight keeps its own price', [...keptPrices(twice, flights, opts)].map(([id, k]) => [id, k.total, k.trucks]),
    [['june', 45000, ['0200']], ['march', 30000, ['0100']]])
}

section('revise: a market reopens on the dates the client asked for')
{
  // A truck shared between Dallas and Fort Worth holds its Dallas days plus a travel day, not Dallas's booked range.
  const shared = [hold({ id: 's1', market: 'Dallas, TX', start_date: '2026-11-09', end_date: '2026-12-05',
    features: feat({ requestedStart: '2026-11-09', requestedEnd: '2026-12-04' }) })]
  eq('the stored requested dates win over the hold span', [reviseRows(shared).rows[0].startDate, reviseRows(shared).rows[0].endDate], ['2026-11-09', '2026-12-04'])
  eq('older holds without them fall back to the span', reviseRows([hold()]).rows[0].endDate, '2026-12-04')
}

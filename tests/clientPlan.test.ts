/**
 * A client's multi-market quote: the client rules and what a client sees.
 *
 * Run with: npm test
 */
import fs from 'fs'
import { eq, section } from './harness'
import { parseClientPlan, clientLine, sameTrucks, CLIENT_MAX_MARKETS } from '@/lib/clientPlan'
import { CLIENT_MAX_TRUCKS } from '@/lib/pricing'
import { buildJobs, planOrder, DEFAULT_ENGINE, type EngineSettings, type OrderLine } from '@/lib/planning/order'
import { planStretches, describeBooked, describeQuoted } from '@/lib/planning/booking'
import type { LineQuote } from '@/lib/planning/quote'

const today = new Date('2026-11-09T15:00:00Z')
const row = (over: Record<string, unknown> = {}) => ({ id: 'r1', market: 'Dallas, TX', startDate: '2026-11-23', endDate: '2026-12-04', trucks: 2, ...over })
const refused = (input: unknown) => {
  const r = parseClientPlan(input, today)
  return 'error' in r ? r.error : null
}

section('client multi-market: the client rules')
{
  const ok = parseClientPlan({ rows: [row(), row({ id: 'r2', market: 'Austin, TX' })] }, today)
  eq('a valid order parses', 'rows' in ok && ok.rows.length, 2)
  eq('defaults: Mon-Fri, 8 hours, shadow fencing on', 'rows' in ok && [ok.rows[0].daysPerWeek, ok.rows[0].hours, ok.features], [5, 8, { shadowFencing: true, smartDirectional: false, deviceId: false }])
  eq('no markets', refused({ rows: [] }), 'Add at least one market.')
  eq(`more than ${CLIENT_MAX_MARKETS} markets`, /^Up to 10 markets/.test(refused({ rows: Array.from({ length: CLIENT_MAX_MARKETS + 1 }, (_, i) => row({ id: `r${i}`, trucks: 1 })) }) ?? ''), true)
  eq(`more than ${CLIENT_MAX_TRUCKS} trucks across the order`, /^Up to 20 trucks/.test(refused({ rows: [row({ trucks: 12 }), row({ id: 'r2', trucks: 9 })] }) ?? ''), true)
  eq('a start inside the lead time', /can't be booked online/.test(refused({ rows: [row({ startDate: '2026-11-10' })] }) ?? ''), true)
  eq('a start already past', /already passed/.test(refused({ rows: [row({ startDate: '2026-11-01' })] }) ?? ''), true)
  eq('a date that does not exist', /^Dates for/.test(refused({ rows: [row({ endDate: '2026-11-31' })] }) ?? ''), true)
  eq('an end before the start', /^Dates for/.test(refused({ rows: [row({ endDate: '2026-11-20' })] }) ?? ''), true)
  eq('trucks as text', /^Trucks for/.test(refused({ rows: [row({ trucks: '2' })] }) ?? ''), true)
  eq('a fraction of a truck', /^Trucks for/.test(refused({ rows: [row({ trucks: 1.5 })] }) ?? ''), true)
  eq('3 days a week is a staff schedule', /^Schedule for/.test(refused({ rows: [row({ daysPerWeek: 3 })] }) ?? ''), true)
  eq('hours past 12', /^Hours for/.test(refused({ rows: [row({ hours: 14 })] }) ?? ''), true)
  eq('true is not an hour count', /^Hours for/.test(refused({ rows: [row({ hours: true })] }) ?? ''), true)
  eq('two rows with one id', refused({ rows: [row(), row()] }), 'Each market needs its own id.')
  eq('a feature that is not on or off', refused({ rows: [row()], features: { deviceId: 'yes' } }), 'Features must be on or off.')
  const sent = parseClientPlan({ rows: [row({ lat: 10, lng: 20, standardMarket: 'Nowhere' })], features: {}, brandMarkupPct: 0, clientType: 'Agency' }, today)
  eq('coordinates and anything else the client sends are dropped', 'rows' in sent && Object.keys(sent.rows[0]).sort(), ['daysPerWeek', 'endDate', 'hours', 'id', 'market', 'startDate', 'trucks'])
}

section('client multi-market: what a client sees')
{
  const lq = {
    id: 'r1', market: 'Dallas, TX', startDate: '2026-11-23', endDate: '2026-12-04', trucks: 2, daysPerWeek: 5, hours: 8,
    activationDays: 10, calendarDays: 12, truckDays: 20, requestedTruckDays: 20,
    delivery: { firstDay: '2026-11-23', lastDay: '2026-12-04', fullWeeks: 2, fullWeekDays: 10, partialWeek: null, days: 20 },
    dailyRate: 1500, hourSurcharge: 0, effectiveDailyRate: 1500, shadowFencingFloored: false,
    baseMedia: 30000, shadowFencing: 900, smartDirectional: 0, deviceId: 0, media: 30900,
    transport: { outcome: 'ABSORBED', billed: 0, absorbedCost: 4321 }, transportNote: 'absorbed: long run',
    total: 30900, missing: 0,
    assigned: [{ truckNumber: '9999', sharedWith: null, hopRoadMiles: 0 }],
    arrivals: [{ truckNumber: '9999', from: 'Denver', fromKind: 'GPS', miles: 660, transportDays: 2, outOfMarket: true, charge: 0, ourCost: 4321 }],
  } as unknown as LineQuote
  const json = JSON.stringify(clientLine(lq))
  eq('no truck numbers, origins, our costs or reasons', ['9999', 'Denver', '4321', 'absorbed', 'assigned', 'arrivals', 'ourCost'].filter(t => json.includes(t)), [])
  eq('the client\'s figures are there', [clientLine(lq).total, clientLine(lq).transport, clientLine(lq).truckDays], [30900, 0, 20])
}

section('client multi-market: shared booking helpers')
{
  const S: EngineSettings = { ...DEFAULT_ENGINE, today: '2026-09-25' }
  const line = (id: string, market: string, lat: number, lng: number): OrderLine => ({ id, market, lat, lng, startDate: '2026-10-12', endDate: '2026-10-25', trucks: 1, daysPerWeek: 3, hours: 12 })
  const a = line('dal', 'Dallas', 32.78, -96.80)
  const b = line('ftw', 'Fort Worth', 32.75, -97.33)
  eq('a shared truck: one job', buildJobs([a, b], S).jobs.length, 1)
  const fleet = [{ truckNumber: '1261', jobs: [], gps: { lat: 32.78, lng: -96.80 }, gpsLabel: 'Dallas' }] as Parameters<typeof planOrder>[1]
  const plan = planOrder([a, b], fleet, S)
  const st = planStretches(plan)
  eq('one stretch per market visit, each naming the market it alternates with', st.map(x => [x.truckNumber, x.stint.market, x.partner]), [
    ['1261', 'Dallas', 'Fort Worth'], ['1261', 'Fort Worth', 'Dallas'], ['1261', 'Dallas', 'Fort Worth'],
  ])
  const q = { market: 'Dallas, TX', trucks: 2, daysPerWeek: 5, hours: 8, startDate: '2026-11-23', endDate: '2026-12-04', delivery: { firstDay: '2026-11-23', lastDay: '2026-12-04', fullWeeks: 2, fullWeekDays: 10, partialWeek: null, days: 20 } } as unknown as LineQuote
  eq('a booked market as delivered', describeBooked(q), 'Dallas, TX: 2 trucks, Mon-Fri x 8h, 2026-11-23 to 2026-12-04, 20 truck-days')
  eq('trucks left out of a market', describeQuoted(q, 1), 'Dallas, TX: 1 truck, 2026-11-23 to 2026-12-04, Mon-Fri x 8h')
}

section('client multi-market: the booking path')
{
  const src = fs.readFileSync('lib/clientMultiMarket.ts', 'utf8')
  eq('writes under the trucks\' locks, AT&T soft holds counted (no excludeAttSoft)', src.includes('writeHoldsExclusive(') && !src.includes('excludeAttSoft'), true)
  eq('books only at the total the client was shown', src.includes('Math.abs(quote.summary.grandTotal - expectedTotal) >= 1'), true)
  eq('and only the markets and trucks shown', src.includes('!sameTrucks(quote.lines, expectedTrucks'), true)
  eq('same trucks per market', sameTrucks([{ id: 'aus', trucks: 1 }, { id: 'den', trucks: 2 }], { aus: 1, den: 2 }), true)
  eq('another market at the same total is not what was shown', sameTrucks([{ id: 'den', trucks: 1 }], { aus: 1 }), false)
  eq('a market dropped', sameTrucks([{ id: 'aus', trucks: 1 }], { aus: 1, den: 1 }), false)
  eq('fewer trucks in a market', sameTrucks([{ id: 'aus', trucks: 1 }], { aus: 2 }), false)
  eq('a retry never answers from another client\'s booking', src.includes('h.client_user_id !== session.id'), true)
  eq('one expiry for the booking, the client\'s standard hold', src.includes('bookingHoldExpiry(stretches.map(x => x.stint.start), DEFAULT_HOLD_DAYS'), true)
  const staff = fs.readFileSync('app/api/plan/hold/route.ts', 'utf8')
  eq('staff and client book what fits the same way', staff.includes('bookWhatFits(body, chosen, booking)') && src.includes('bookWhatFits(p.req, lines, asked'), true)
}

/**
 * Grouping reservations into bookings for the Reservations page (lib/bookings.ts).
 * Run with: npm test
 */
import { eq, section } from './harness'
import { bookingCardKey, bookingKey, earliestExpiryDate, expiryEdits, isMultiMarket, marketGroups, summarizeBooking } from '@/lib/bookings'

const h = (campaign_group_id: string | null, truck_number: string, market: string, quoted_total: number | null, extra: Partial<{ sfdc: string; start: string; end: string; exp: string }> = {}) => ({
  campaign_group_id, sfdc_opportunity_id: extra.sfdc ?? null, truck_number, market, quoted_total,
  start_date: extra.start ?? '2026-11-09', end_date: extra.end ?? '2026-12-06', expires_at: extra.exp ?? '2026-10-30T23:59:00.000Z',
})

section('bookings: a multi-market quote is one booking')
// Outdoor Media Group, 2026-10-15: 7 markets, one opportunity, 7 campaign groups.
const omg = ['Albany, NY', 'Ithaca, NY', 'Rochester, NY'].map((m, i) => h(`mm_365fe279-4ec4_${i + 1}`, `T${i}`, m, 10000 + i, { sfdc: '006VP00000hUk9VYAS' }))
eq('every market shares the booking key', new Set(omg.map(bookingKey)).size, 1)
eq('the key is the booking, not a market', bookingKey(omg[0]), 'mm_365fe279-4ec4')
eq('two-digit market numbers too', bookingKey(h('mm_7f917fdc_14', 'x', 'Ashland, VA', 1)), 'mm_7f917fdc')
eq('quote-only logs group the same way', bookingKey(h('mmq_abc_2', 'x', 'm', 1)), 'mmq_abc')
eq('recognized as multi-market', isMultiMarket(omg[0]), true)

section('bookings: everything else groups as before')
eq('single-market quote: its campaign group', bookingKey(h('cg_1760_ab12cd', 'x', 'm', 1)), 'cg_1760_ab12cd')
eq('Salesforce push: its opportunity', bookingKey(h(null, 'x', 'm', 1, { sfdc: '006ABC' })), '006ABC')
eq('on its own: none', bookingKey(h(null, 'x', 'm', 1)), null)
eq('not multi-market', isMultiMarket(h('cg_1', 'x', 'm', 1)), false)

section('bookings: the headline figures')
const twoTruckMarket = [
  h('mm_b_1', '7992', 'Nashville, TN', 5000, { exp: '2026-10-17T11:17:00.000Z' }),
  h('mm_b_1', '4840', 'Nashville, TN', 5000, { exp: '2026-10-17T11:17:00.000Z' }),
  h('mm_b_2', '5688', 'Knoxville, TN', 3000, { start: '2026-11-01', exp: '2026-10-16T09:00:00.000Z' }),
]
const sum = summarizeBooking(twoTruckMarket)
eq('total adds each market once, not each hold', sum.total, 8000)
eq('markets and trucks', [sum.markets.length, sum.trucks], [2, 3])
eq('dates span the booking', [sum.start, sum.end], ['2026-11-01', '2026-12-06'])
eq('the earliest expiry is the one to watch', sum.earliestExpiry, '2026-10-16T09:00:00.000Z')
eq('a truck alternating between markets counts once',
  summarizeBooking([h('mm_c_1', '0794', 'Omaha, NE', 1), h('mm_c_2', '0794', 'Lincoln, NE', 1)]).trucks, 1)
eq('no prices: no total', summarizeBooking([h('mm_d_1', 'x', 'm', null)]).total, null)

section('bookings: one card per booking and status (Sarah\'s review)')
// Markets lapse on their own schedules: part on hold, part committed or expired.
const mixed = [{ ...omg[0], status: 'HOLD' }, { ...omg[1], status: 'COMMITTED' }, { ...omg[2], status: 'HOLD' }]
eq('the same status shares a card', bookingCardKey(mixed[0]) === bookingCardKey(mixed[2]), true)
eq('another status is its own card, so its Edit covers exactly it', bookingCardKey(mixed[0]) === bookingCardKey(mixed[1]), false)
eq('nothing to group: no card key', bookingCardKey({ ...h(null, 'x', 'm', 1), status: 'HOLD' }), null)
eq('one tier when every market has it', summarizeBooking([{ ...omg[0], pricing_tier: 'Better' }, { ...omg[1], pricing_tier: 'Better' }]).tier, 'Better')
eq('"Mixed" when markets were priced at different tiers', summarizeBooking([{ ...omg[0], pricing_tier: 'Better' }, { ...omg[1], pricing_tier: 'Best' }]).tier, 'Mixed')
const partlyPriced = summarizeBooking([h('mm_e_1', 'a', 'A', 5000), h('mm_e_2', 'b', 'B', null)])
eq('an unpriced market is counted, not taken as $0', [partlyPriced.total, partlyPriced.unpricedMarkets], [5000, 1])


section('bookings: one expiry change across a booking keeps each market inside its start limit')
{
  const r = (id: string, market: string, start_date: string, expires_at: string | null, truck_number = id, end_date = '2026-12-31') =>
    ({ id, market, start_date, expires_at, truck_number, end_date })
  // Markets start Oct 25 and Nov 20: the Oct 25 hold can run to Oct 21 at the latest.
  const booking = [r('a', 'Dallas, TX', '2026-10-25', '2026-10-21T23:59:59Z'), r('b', 'Houston, TX', '2026-11-20', '2026-10-28T23:59:59Z')]
  const edits = expiryEdits(booking, '2026-11-01')
  eq('extending stops the earlier market at its limit', edits.map(e => [e.id, e.expiresOn, e.heldAtStartLimit, e.changed]),
    [['a', '2026-10-21', true, false], ['b', '2026-11-01', false, true]])
  eq('shortening applies to every market', expiryEdits(booking, '2026-10-20').map(e => e.expiresOn), ['2026-10-20', '2026-10-20'])
  eq('a later expiry already set is kept, not pulled back to the limit',
    expiryEdits([r('a', 'Dallas, TX', '2026-10-25', '2026-10-23T23:59:59Z'), booking[1]], '2026-11-01')[0].expiresOn, '2026-10-23')
  eq('one market (one start date): the chosen date applies as before',
    expiryEdits([r('a', 'Dallas, TX', '2026-10-25', null), r('c', 'Dallas, TX', '2026-10-25', null)], '2026-11-01').map(e => [e.expiresOn, e.heldAtStartLimit]),
    [['2026-11-01', false], ['2026-11-01', false]])
  // Houston already runs to Nov 5; extending the booking to Nov 1 must not pull it back.
  const later = [booking[0], r('b', 'Houston, TX', '2026-11-20', '2026-11-05T23:59:59Z')]
  eq('extending never shortens a market that already lapses later', expiryEdits(later, '2026-11-01').map(e => [e.id, e.expiresOn, e.changed]),
    [['a', '2026-10-21', false], ['b', '2026-11-05', false]])
  // Truck T alternates Dallas (from Oct 25) and Fort Worth weekly: one job, capped by Oct 25 for every stretch.
  const shared = [
    r('s1', 'Dallas, TX', '2026-10-25', '2026-10-21T23:59:59Z', 'T', '2026-10-28'),
    r('s2', 'Fort Worth, TX', '2026-10-29', '2026-10-21T23:59:59Z', 'T', '2026-11-04'),
    r('s3', 'Dallas, TX', '2026-11-05', '2026-10-21T23:59:59Z', 'T', '2026-11-11'),
    r('h', 'Houston, TX', '2026-11-20', '2026-10-21T23:59:59Z', 'H', '2026-12-04'),
  ]
  eq('a shared truck\'s stretches share their job\'s start limit', expiryEdits(shared, '2026-11-01').map(e => [e.id, e.expiresOn]),
    [['s1', '2026-10-21'], ['s2', '2026-10-21'], ['s3', '2026-10-21'], ['h', '2026-11-01']])
  eq('the dialog opens on the earliest expiry, as the card badge shows', earliestExpiryDate([booking[1], booking[0], r('x', 'Waco, TX', '2026-12-01', null)]), '2026-10-21')
}

section('bookings: a market split across two cards is not counted as whole on either')
{
  // Albany's two holds: one still on hold, one lapsed. Buffalo is all on hold.
  const row = (campaign_group_id: string, truck_number: string, market: string, quoted_total: number | null, status: string) =>
    ({ campaign_group_id, sfdc_opportunity_id: null, truck_number, market, quoted_total, status,
       start_date: '2026-11-09', end_date: '2026-12-04', expires_at: '2026-10-30T23:59:00.000Z' })
  const all = [row('mm_x_1', 'A1', 'Albany, NY', 42000, 'HOLD'), row('mm_x_1', 'A2', 'Albany, NY', 42000, 'EXPIRED'), row('mm_x_2', 'B1', 'Buffalo, NY', 21000, 'HOLD')]
  const onHold = summarizeBooking(all.filter(r => r.status === 'HOLD'), all)
  eq('the Hold card counts Buffalo, not half of Albany', [onHold.total, onHold.splitMarkets], [21000, 1])
  const expired = summarizeBooking(all.filter(r => r.status === 'EXPIRED'), all)
  eq('the Expired card counts nothing as whole', [expired.total, expired.splitMarkets], [null, 1])
  eq('without the whole booking, as before', summarizeBooking(all.filter(r => r.status === 'HOLD')).total, 63000)
}

section('bookings: a multi-market card shows each market as a subgroup')
{
  const f = (activationDays?: number) => activationDays === undefined ? null : JSON.stringify({ activationDays })
  const row = (g: string, truck: string, market: string, start: string, end: string, features: string | null = null) =>
    ({ campaign_group_id: g, sfdc_opportunity_id: '006X', truck_number: truck, market, start_date: start, end_date: end, features })
  const rows = [
    row('mm_b_2', '0912', 'New York City, NY', '2026-11-16T00:00:00.000Z', '2026-11-27T00:00:00.000Z', f(10)),
    row('mm_b_1', '7314', 'Buffalo, NY', '2026-11-09', '2026-11-28', f(20)),
    row('mm_b_2', '0382', 'New York City, NY', '2026-11-16', '2026-11-27', f(10)),
    row('mm_b_3', '4840', 'Albany, NY', '2026-11-09', '2026-11-13'),
    // A truck alternating weekly: two stretches in one market.
    row('mm_b_4', '1488', 'Ithaca, NY', '2026-11-23', '2026-11-27', f(10)),
    row('mm_b_4', '1488', 'Ithaca, NY', '2026-11-09', '2026-11-13', f(10)),
  ]
  const g = marketGroups(rows)
  eq('one subgroup per market line', g.length, 4)
  eq('ordered by start date, then market', g.map(x => x.market), ['Albany, NY', 'Buffalo, NY', 'Ithaca, NY', 'New York City, NY'])
  eq('a subgroup spans its holds', [g[2].start, g[2].end], ['2026-11-09', '2026-11-27'])
  eq('activation days from the quote when stored', [g[1].days, g[1].daysKind], [20, 'activation'])
  eq('calendar days when not', [g[0].days, g[0].daysKind], [5, 'calendar'])
  eq('trucks under it, by start then number', g[3].rows.map(r => r.truck_number), ['0382', '0912'])
  eq('a truck\'s stretches in date order', g[2].rows.map(r => r.start_date), ['2026-11-09', '2026-11-23'])
  eq('every row lands in exactly one subgroup', g.reduce((n, x) => n + x.rows.length, 0), rows.length)
  eq('unreadable features fall back to calendar days', marketGroups([row('mm_c_1', '1', 'X', '2026-11-01', '2026-11-03', '{bad')])[0].daysKind, 'calendar')
}

/**
 * Grouping reservations into bookings for the Reservations page (lib/bookings.ts).
 * Run with: npm test
 */
import { eq, section } from './harness'
import { bookingKey, isMultiMarket, summarizeBooking } from '@/lib/bookings'

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

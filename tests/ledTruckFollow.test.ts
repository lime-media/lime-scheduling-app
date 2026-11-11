/**
 * A won reservation follows the truck LED scheduled it on (lib/ledTruckFollow.ts):
 * one-for-one with the trucks LED runs the job on, within the hold's market and dates.
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { labelCities, ledTruckMoves, type FollowHold, type FollowRow } from '@/lib/ledTruckFollow'

const JOB = '26-0500-300'
const TODAY = '2026-10-27'
const hold = (over: Partial<FollowHold> = {}): FollowHold => ({
  id: 'h1', truck_number: '6907', start_date: '2026-11-02', end_date: '2026-11-04', market: 'Phoenix, AZ', state: 'AZ', job_number: JOB, days_sold: 3, ...over,
})
/** LED runs `job` on `truck` on each of `days`, in Phoenix unless said. */
const led = (truck: string, days: string[], over: Partial<FollowRow> = {}): FollowRow[] =>
  days.map(d => ({ truck_number: truck, job_number: JOB, shift_start: d, market: 'Phoenix', state: 'AZ', standard_market_name: 'Phoenix, AZ', ...over }))
const DAYS = ['2026-11-02', '2026-11-03', '2026-11-04']
const moves = (holds: FollowHold[], rows: FollowRow[]) => ledTruckMoves(holds, rows, TODAY).map(m => [m.holdId, m.from, m.to])

section('ledTruckMoves: the hold follows LED\'s truck')
eq('LED runs the job on another truck only: move there', moves([hold()], led('1261', DAYS)), [['h1', '6907', '1261']])
eq('job number case doesn\'t matter', moves([hold({ job_number: JOB.toLowerCase() })], led('1261', DAYS)), [['h1', '6907', '1261']])
eq('already on LED\'s truck: stays', moves([hold()], led('6907', DAYS)), [])
eq('LED runs some days on its own truck: stays (split, not a move)', moves([hold()], [...led('6907', [DAYS[0]]), ...led('1261', DAYS.slice(1))]), [])
eq('LED splits it over two other trucks: the one with the most days', moves([hold()], [...led('1261', [DAYS[0]]), ...led('4322', DAYS.slice(1))]), [['h1', '6907', '4322']])
eq('LED hasn\'t scheduled it: stays', moves([hold()], []), [])
eq('the job outside the hold\'s dates: stays', moves([hold()], led('1261', ['2026-11-10'])), [])
eq('another job on another truck: stays', moves([hold()], led('1261', DAYS, { job_number: '26-0387-300' })), [])
eq('no linked job (not committed): stays', moves([hold({ job_number: null })], led('1261', DAYS)), [])
eq('a finished booking keeps its truck', moves([hold({ start_date: '2026-10-01', end_date: '2026-10-03' })], led('1261', ['2026-10-01', '2026-10-02', '2026-10-03'])), [])

section('markets: every market of a booking shares the job number')
const az = hold({ id: 'az' })
const nm = hold({ id: 'nm', truck_number: '4322', market: 'Albuquerque, NM', state: 'NM' })
eq('another market\'s truck isn\'t this hold\'s', moves([az], led('1261', DAYS, { market: 'Albuquerque', state: 'NM', standard_market_name: 'Albuquerque, NM' })), [])
eq('two markets, each moved to its own market\'s truck',
  moves([az, nm], [...led('1261', DAYS), ...led('5688', DAYS, { market: 'Albuquerque', state: 'NM', standard_market_name: 'Albuquerque, NM' })]).sort(),
  [['az', '6907', '1261'], ['nm', '4322', '5688']])
eq('a truck another hold of the job is on is never moved onto', moves([az, hold({ id: 'h2', truck_number: '1261' })], led('1261', DAYS)), [])

section('two holds, LED\'s trucks: one-for-one, in truck-number order')
eq('same market, same dates, one LED truck: the first hold takes it, the other keeps its truck', moves([hold({ id: 'a' }), hold({ id: 'b', truck_number: '4322' })], led('1261', DAYS)), [['b', '4322', '1261']])
eq('same market, two LED trucks: one each', moves([hold({ id: 'a' }), hold({ id: 'b', truck_number: '4322' })], [...led('1261', DAYS), ...led('5688', DAYS)]).sort(), [['a', '6907', '5688'], ['b', '4322', '1261']])
eq('one already on LED\'s truck, the other moves to the one left',
  moves([hold({ id: 'a', truck_number: '1261' }), hold({ id: 'b', truck_number: '4322' })], [...led('1261', DAYS), ...led('5688', DAYS)]), [['b', '4322', '5688']])

section('a Salesforce multi-market hold: LED\'s city must be one its label names')
const multi = (over: Partial<FollowHold> = {}) => hold({ market: 'Multi-market: Detroit, Los Angeles, CA', state: null, ...over })
const DET = { market: 'Detroit', state: 'MI', standard_market_name: 'Detroit, MI' }
const LA = { market: 'Los Angeles', state: 'CA', standard_market_name: 'Los Angeles, CA' }
eq('the only place it can go: moves', moves([multi()], led('1261', DAYS, { market: 'Detroit', state: 'MI', standard_market_name: 'Detroit, MI' })), [['h1', '6907', '1261']])
eq('two such holds, two LED trucks: one each',
  moves([multi({ id: 'a' }), multi({ id: 'b', truck_number: '4322' })], [...led('1261', DAYS, DET), ...led('5688', DAYS, LA)]).sort(), [['a', '6907', '5688'], ['b', '4322', '1261']])
eq('its sibling already on its LED truck, it takes the other',
  moves([multi({ id: 'a', truck_number: '1261' }), multi({ id: 'b', truck_number: '4322' })], [...led('1261', DAYS, DET), ...led('5688', DAYS, LA)]), [['b', '4322', '5688']])

section('dates: one truck can carry two markets of a booking in turn')
const NEXT = ['2026-11-09', '2026-11-10', '2026-11-11']
eq('two holds on one truck, different weeks, LED moves both to one other truck: both move',
  moves([multi({ id: 'a' }), multi({ id: 'b', start_date: NEXT[0], end_date: NEXT[2] })], [...led('1261', DAYS, DET), ...led('1261', NEXT, LA)]).sort(),
  [['a', '6907', '1261'], ['b', '6907', '1261']])
eq('a hold of the job on that truck in another week doesn\'t claim it',
  moves([hold(), hold({ id: 'h2', truck_number: '1261', start_date: NEXT[0], end_date: NEXT[2] })], [...led('1261', DAYS), ...led('1261', NEXT)]), [['h1', '6907', '1261']])
eq('a city its label doesn\'t name: stays', moves([multi()], led('1261', DAYS, { market: 'Phoenix', state: 'AZ', standard_market_name: 'Phoenix, AZ' })), [])
eq('by LED\'s standard market name', moves([multi()], led('1261', DAYS, { market: 'Downtown LA', state: 'CA', standard_market_name: 'Los Angeles, CA' })), [['h1', '6907', '1261']])
eq('a label with states after each city', moves([multi({ market: 'Multi-market: Los Angeles, CA, Detroit, MI' })], led('1261', DAYS, DET)), [['h1', '6907', '1261']])
eq('a city that is also a state name ("New York")',
  moves([multi({ market: 'Multi-market: New York, Detroit' })], led('1261', DAYS, { market: 'New York', state: 'NY', standard_market_name: 'New York, NY' })), [['h1', '6907', '1261']])
// Sarah's review: a label's state counts, so Detroit, TX isn't Detroit, MI.
eq('a city in another state than the label gives: stays',
  moves([multi({ market: 'Multi-market: Detroit, MI, Los Angeles, CA' })], led('1261', DAYS, { market: 'Detroit', state: 'TX', standard_market_name: 'Detroit, TX' })), [])
eq('a city the label names without a state: any state', moves([multi({ market: 'Multi-market: Detroit, Los Angeles, CA' })], led('1261', DAYS, DET)), [['h1', '6907', '1261']])
eq('LED row with no state of its own: its standard market gives it',
  moves([multi({ market: 'Multi-market: Detroit, MI, Los Angeles, CA' })], led('1261', DAYS, { market: 'Detroit', state: '', standard_market_name: 'Detroit, MI' })), [['h1', '6907', '1261']])
eq('a suburb filed under the labelled city\'s standard market',
  moves([multi({ market: 'Multi-market: Portland, OR, Seattle, WA' })], led('1261', DAYS, { market: 'Beaverton', state: 'OR', standard_market_name: 'Portland, OR' })), [['h1', '6907', '1261']])
eq('a suburb in another state filed under the labelled city\'s standard market',
  moves([multi({ market: 'Multi-market: New York, NY, Detroit, MI' })], led('1261', DAYS, { market: 'Jersey City', state: 'NJ', standard_market_name: 'New York, NY' })), [['h1', '6907', '1261']])
eq('labelCities: a state belongs to the city before it', labelCities('Multi-market: Detroit, Los Angeles, CA'), [{ city: 'detroit', state: null }, { city: 'los angeles', state: 'CA' }])
eq('Washington, DC in a label', moves([multi({ market: 'Multi-market: Washington, DC, Detroit, MI' })], led('1261', DAYS, { market: 'Washington', state: 'DC', standard_market_name: 'Washington, DC' })), [['h1', '6907', '1261']])

section('LED\'s truck is followed before every day sold is scheduled')
eq('one of three days so far on another truck: moves', moves([hold()], led('1261', [DAYS[0]])), [['h1', '6907', '1261']])
eq('two of three days: moves', moves([hold()], led('1261', DAYS.slice(0, 2))), [['h1', '6907', '1261']])
eq('LED also runs a day on its own truck: stays', moves([hold()], [...led('6907', [DAYS[0]]), ...led('1261', DAYS)]), [])
eq('the rest of its days on that truck are another market of the job: moves on its one day',
  moves([hold()], [...led('1261', [DAYS[0]]), ...led('1261', DAYS.slice(1), { market: 'Albuquerque', state: 'NM', standard_market_name: 'Albuquerque, NM' })]), [['h1', '6907', '1261']])
eq('a six-day week sold 6 of 7: six days is enough', moves([hold({ end_date: '2026-11-08', days_sold: 6 })], led('1261', ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'])), [['h1', '6907', '1261']])
eq('a hold that sells no days: nothing to follow', moves([hold({ days_sold: 0 })], led('1261', DAYS)), [])

section('another live hold of the same opportunity on that truck')
const opp = { sfdc_opportunity_id: '006A000000abcDE' }
eq('a market not yet won holds LED\'s truck: stays',
  ledTruckMoves([hold(opp)], led('1261', DAYS), TODAY, [{ id: 'other', truck_number: '1261', start_date: DAYS[0], end_date: DAYS[2], ...opp }]).length, 0)
eq('another opportunity\'s hold there: moves (a clash, shown as a conflict)',
  ledTruckMoves([hold(opp)], led('1261', DAYS), TODAY, [{ id: 'other', truck_number: '1261', start_date: DAYS[0], end_date: DAYS[2], sfdc_opportunity_id: '006A000000zzzZZ' }]).length, 1)

section('only holds inside the dates LED\'s rows cover')
eq('wholly inside: moves', ledTruckMoves([hold()], led('1261', DAYS), TODAY, [], { from: '2026-10-01', to: '2026-11-30' }).length, 1)
eq('reaching past the last day LED\'s rows cover: stays (its own truck there is unseen)',
  ledTruckMoves([hold()], led('1261', DAYS), TODAY, [], { from: '2026-10-01', to: '2026-11-03' }).length, 0)

section('prod-shaped cases (2026-11-11): the trucks follow LED one-for-one')
// Mon–Fri days between two dates, inclusive.
const weekdays = (from: string, to: string) => {
  const out: string[] = []
  for (let d = new Date(from + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10))
  }
  return out
}
const P_TODAY = '2026-11-11'
const pmoves = (holds: FollowHold[], rows: FollowRow[]) => ledTruckMoves(holds, rows, P_TODAY).map(m => [m.holdId, m.from, m.to]).sort()
const ph = (id: string, truck: string, start: string, end: string, sold = 10) =>
  hold({ id, truck_number: truck, start_date: start, end_date: end, days_sold: sold })
eq('held 1002, LED runs it on 1261: moves to 1261',
  pmoves([ph('a', '1002', '2026-10-19', '2026-12-13', 40)], led('1261', weekdays('2026-10-20', '2026-12-11'))), [['a', '1002', '1261']])
eq('held 0768 and 1727, LED runs it on 0820 and 9269: both move, one each',
  pmoves([ph('a', '0768', '2026-11-17', '2026-11-30'), ph('b', '1727', '2026-11-17', '2026-11-30')],
    [...led('0820', weekdays('2026-11-17', '2026-11-30')), ...led('9269', weekdays('2026-11-17', '2026-11-30'))]),
  [['a', '0768', '0820'], ['b', '1727', '9269']])
eq('held 0881 and 4840, LED runs it on 0881 and 0912: 0881 stays, 4840 moves to 0912',
  pmoves([ph('a', '0881', '2026-11-09', '2026-12-17', 29), ph('b', '4840', '2026-11-09', '2026-12-17', 29)],
    [...led('0881', weekdays('2026-11-09', '2026-12-17')), ...led('0912', weekdays('2026-11-09', '2026-12-17'))]),
  [['b', '4840', '0912']])
eq('held 7314, LED runs it on 0382 (6 days) and 9378 (1 day): moves to 0382',
  pmoves([ph('a', '7314', '2026-11-11', '2026-11-18', 6)],
    [...led('0382', ['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-16', '2026-11-17', '2026-11-18']), ...led('9378', ['2026-11-11'])]),
  [['a', '7314', '0382']])
// Held Nov 16–30 on five trucks; LED runs it Nov 30–Dec 8 on five, one of them
// (4378) the same: only Nov 30 is inside the dates. 4378 keeps its truck and
// the other four holds take the other four LED trucks; their dates stay
// (Reservations flags LED's dates: ledDaysOutside).
const LATE = weekdays('2026-11-30', '2026-12-08')
eq('held on 5 trucks Nov 16–30, LED runs 5 trucks Nov 30–Dec 8: only the overlap day counts',
  pmoves(['0786', '4378', '7267', '7278', '7402'].map((t, i) => ph(`h${i}`, t, '2026-11-16', '2026-11-30', 11)),
    ['0751', '1106', '4378', '7417', '7450'].flatMap(t => led(t, LATE))),
  [['h0', '0786', '0751'], ['h2', '7267', '1106'], ['h3', '7278', '7417'], ['h4', '7402', '7450']])
eq('a hold that can only go one place picks first',
  moves([multi({ id: 'a', truck_number: '1000', market: 'Multi-market: Detroit, Phoenix' }), multi({ id: 'b', truck_number: '4322', market: 'Multi-market: Detroit, Los Angeles' })],
    [...led('1261', DAYS, DET), ...led('5688', DAYS, { market: 'Phoenix', state: 'AZ', standard_market_name: 'Phoenix, AZ' })]).sort(),
  [['a', '1000', '5688'], ['b', '4322', '1261']])
eq('no LED program: nothing moves', pmoves([ph('a', '5156', '2026-11-12', '2026-11-14', 3)], []), [])
eq('two holds of the job never land on one truck over the same days',
  pmoves([ph('a', '0768', '2026-11-17', '2026-11-30'), ph('b', '1727', '2026-11-17', '2026-11-30')], led('0820', weekdays('2026-11-17', '2026-11-30'))),
  [['a', '0768', '0820']])

/**
 * A won reservation follows the truck LED scheduled it on (lib/ledTruckFollow.ts):
 * only when LED's choice is unambiguous, and only within the hold's market.
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { ledTruckMoves, type FollowHold, type FollowRow } from '@/lib/ledTruckFollow'

const JOB = '26-0500-300'
const TODAY = '2026-10-27'
const hold = (over: Partial<FollowHold> = {}): FollowHold => ({
  id: 'h1', truck_number: '6907', start_date: '2026-11-02', end_date: '2026-11-04', market: 'Phoenix, AZ', state: 'AZ', job_number: JOB, ...over,
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
eq('LED splits it over two other trucks: stays', moves([hold()], [...led('1261', [DAYS[0]]), ...led('4322', DAYS.slice(1))]), [])
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

section('two holds that could each take the truck: neither moves')
eq('same market, same dates, one LED truck', moves([hold({ id: 'a' }), hold({ id: 'b', truck_number: '4322' })], led('1261', DAYS)), [])
eq('same market, two LED trucks: each could go to either', moves([hold({ id: 'a' }), hold({ id: 'b', truck_number: '4322' })], [...led('1261', DAYS), ...led('5688', DAYS)]), [])
eq('one already on LED\'s truck, the other moves to the one left',
  moves([hold({ id: 'a', truck_number: '1261' }), hold({ id: 'b', truck_number: '4322' })], [...led('1261', DAYS), ...led('5688', DAYS)]), [['b', '4322', '5688']])

section('a hold whose market can\'t be read (Salesforce multi-market)')
const multi = (over: Partial<FollowHold> = {}) => hold({ market: 'Multi-market: Detroit, Los Angeles, CA', state: null, ...over })
eq('the only place it can go: moves', moves([multi()], led('1261', DAYS, { market: 'Detroit', state: 'MI', standard_market_name: 'Detroit, MI' })), [['h1', '6907', '1261']])
eq('two such holds, two LED trucks: neither moves',
  moves([multi({ id: 'a' }), multi({ id: 'b', truck_number: '4322' })], [...led('1261', DAYS, { state: 'MI' }), ...led('5688', DAYS, { state: 'CA' })]), [])
eq('its sibling already on its LED truck, it takes the other',
  moves([multi({ id: 'a', truck_number: '1261' }), multi({ id: 'b', truck_number: '4322' })], [...led('1261', DAYS, { state: 'MI' }), ...led('5688', DAYS, { state: 'CA' })]), [['b', '4322', '5688']])

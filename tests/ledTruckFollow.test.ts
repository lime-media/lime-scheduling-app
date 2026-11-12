/**
 * A won reservation mirrors what LED runs, trucks and dates
 * (lib/ledTruckFollow.ts): runs per truck, the sold shortfall kept, a reused
 * job number left alone, and nothing changed once mirrored.
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import {
  labelCities, ledMirrorPlans, ledMirrorStandings, ledRuns, mirroredFeatures, soldShapeOf,
  type FollowHold, type FollowRow, type MirrorPlan,
} from '@/lib/ledTruckFollow'

const JOB = '26-0500-300'
const TODAY = '2026-11-11'
const hold = (over: Partial<FollowHold> = {}): FollowHold => ({
  id: 'h1', truck_number: '1002', start_date: '2026-11-02', end_date: '2026-11-27', market: 'Phoenix, AZ', state: 'AZ',
  job_number: JOB, booking: 'B1', features: null, ...over,
})
const PHX = { market: 'Phoenix', state: 'AZ', standard_market_name: 'Phoenix, AZ' }
/** LED runs the job on `truck` on each of `days`, in Phoenix unless said. */
const led = (truck: string, days: string[], over: Partial<FollowRow> = {}): FollowRow[] =>
  days.map(d => ({ truck_number: truck, job_number: JOB, shift_start: d, ...PHX, ...over }))
/** Mon–Fri days between two dates, inclusive. */
const weekdays = (from: string, to: string) => {
  const out: string[] = []
  for (let d = new Date(from + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10))
  }
  return out
}
const plan = (holds: FollowHold[], rows: FollowRow[]) => ledMirrorPlans(holds, rows, TODAY)
/** The holds a booking ends up with after its plans, as "truck start end", sorted. */
function after(holds: FollowHold[], plans: MirrorPlan[]): FollowHold[] {
  let out = [...holds]
  for (const p of plans) {
    for (const u of p.update) out = out.map(h => h.id === u.id ? { ...h, truck_number: u.to.truck, start_date: u.to.start, end_date: u.to.end, features: mirroredFeatures(h.features, u.to, p.sold) } : h)
    p.create.forEach((c, i) => {
      const t = holds.find(h => h.id === c.templateId)!
      out.push({ ...t, id: `${t.id}+${i}`, truck_number: c.to.truck, start_date: c.to.start, end_date: c.to.end, features: mirroredFeatures(t.features, c.to, p.sold) })
    })
    out = out.filter(h => !p.remove.includes(h.id))
    out = out.map(h => p.stamp.includes(h.id) ? { ...h, features: mirroredFeatures(h.features, null, p.sold) } : h)
  }
  return out
}
const shape = (hs: FollowHold[]) => hs.map(h => `${h.truck_number} ${h.start_date} ${h.end_date}`).sort()
const mirror = (holds: FollowHold[], rows: FollowRow[]) => after(holds, plan(holds, rows).plans)

section('ledRuns: one run per truck, split only by a working day')
eq('Mon–Fri across a weekend stays one run', ledRuns(weekdays('2026-11-02', '2026-11-13').map(day => ({ truck: '1261', day }))),
  [{ truck: '1261', start: '2026-11-02', end: '2026-11-13', days: 10 }])
eq('a missing working day splits it (Wednesday is worked the week before)',
  ledRuns(weekdays('2026-11-02', '2026-11-13').filter(d => d !== '2026-11-11').map(day => ({ truck: '1261', day }))),
  [{ truck: '1261', start: '2026-11-02', end: '2026-11-10', days: 7 }, { truck: '1261', start: '2026-11-12', end: '2026-11-13', days: 2 }])
eq('another truck is another run', ledRuns([{ truck: '1002', day: '2026-11-02' }, { truck: '1261', day: '2026-11-03' }]).map(r => r.truck), ['1002', '1261'])

section('the reservation mirrors LED\'s trucks and dates (prod-shaped, 2026-11-11)')
eq('a stand-in day: held 1002 Nov 2–27, LED runs 1002 Nov 2 and 1261 the rest → two holds in series',
  shape(mirror([hold()], [...led('1002', ['2026-11-02']), ...led('1261', weekdays('2026-11-03', '2026-11-27'))])),
  ['1002 2026-11-02 2026-11-02', '1261 2026-11-03 2026-11-27'])
eq('held 1002, LED runs it all on 1261: the hold moves', shape(mirror([hold()], led('1261', weekdays('2026-11-02', '2026-11-27')))), ['1261 2026-11-02 2026-11-27'])
eq('two-for-two: held 0768 and 1727, LED runs 0820 and 9269',
  shape(mirror([hold({ id: 'a', truck_number: '0768' }), hold({ id: 'b', truck_number: '1727' })],
    [...led('0820', weekdays('2026-11-17', '2026-11-30')), ...led('9269', weekdays('2026-11-17', '2026-11-30'))])),
  ['0820 2026-11-17 2026-11-30', '9269 2026-11-17 2026-11-30'])
eq('0881 kept, 4840 → 0912 (the same-truck hold keeps its id)',
  plan([hold({ id: 'a', truck_number: '0881' }), hold({ id: 'b', truck_number: '4840' })],
    [...led('0881', weekdays('2026-11-02', '2026-11-27')), ...led('0912', weekdays('2026-11-02', '2026-11-27'))]).plans[0].update.map(u => [u.id, u.from.truck, u.to.truck]),
  [['b', '4840', '0912']])
eq('7314 → 0382 (6 days) and 9378 (1 day): two holds',
  shape(mirror([hold({ truck_number: '7314', start_date: '2026-11-11', end_date: '2026-11-18' })],
    [...led('9378', ['2026-11-11']), ...led('0382', ['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-16', '2026-11-17', '2026-11-18'])])),
  ['0382 2026-11-12 2026-11-18', '9378 2026-11-11 2026-11-11'])
const FIVE = ['0786', '4378', '7267', '7278', '7402'].map((t, i) => hold({ id: `h${i}`, truck_number: t, start_date: '2026-11-16', end_date: '2026-11-30' }))
const LATE = weekdays('2026-11-30', '2026-12-08')
eq('moved dates: held on 5 trucks Nov 16–30, LED runs 5 trucks Nov 30–Dec 8 → LED\'s trucks and dates',
  shape(mirror(FIVE, ['0751', '1106', '4378', '7417', '7450'].flatMap(t => led(t, LATE)))),
  ['0751', '1106', '4378', '7417', '7450'].map(t => `${t} 2026-11-30 2026-12-08`))
eq('4378, on both, keeps its hold (re-dated)', plan(FIVE, ['0751', '1106', '4378', '7417', '7450'].flatMap(t => led(t, LATE))).plans[0].update.find(u => u.id === 'h1')?.to.truck, '4378')

section('what LED hasn\'t scheduled stays held')
const TWO = [hold({ id: 'a', truck_number: '0768' }), hold({ id: 'b', truck_number: '1727' })]
eq('sold 2, LED runs 1 so far: one hold follows, the other keeps its truck and dates',
  shape(mirror(TWO, led('0820', weekdays('2026-11-02', '2026-11-27')))), ['0768 2026-11-02 2026-11-27', '0820 2026-11-02 2026-11-27'])
eq('sold 2, LED runs only the held trucks one after another: can\'t fit, nothing written, flagged',
  (() => { const r = plan(TWO, [...led('0768', weekdays('2026-11-02', '2026-11-13')), ...led('1727', weekdays('2026-11-16', '2026-11-27'))]); return [r.plans.length, r.flags.map(f => f.kind)] })(),
  [0, ['unfit']])
eq('LED runs more trucks than sold: mirrored, and flagged',
  (() => { const r = plan([hold()], [...led('1261', weekdays('2026-11-02', '2026-11-27')), ...led('5688', weekdays('2026-11-02', '2026-11-27'))]); return [shape(after([hold()], r.plans)), r.flags.map(f => f.kind)] })(),
  [['1261 2026-11-02 2026-11-27', '5688 2026-11-02 2026-11-27'], ['more_trucks']])

section('safety')
eq('no LED program: nothing', plan([hold()], []).plans, [])
eq('LED days outside the window (60 days past the end): nothing', plan([hold()], led('1261', ['2027-03-01'])).plans, [])
eq('another job: nothing', plan([hold()], led('1261', ['2026-11-03'], { job_number: '26-0999-300' })).plans, [])
eq('another market of the job: nothing', plan([hold()], led('1261', ['2026-11-03'], { market: 'Albuquerque', state: 'NM', standard_market_name: 'Albuquerque, NM' })).plans, [])
eq('a finished booking: nothing', plan([hold({ start_date: '2026-10-01', end_date: '2026-10-09' })], led('1261', weekdays('2026-10-01', '2026-10-09'))).plans, [])
eq('a job number and market on two live bookings: neither touched, both flagged',
  (() => { const r = plan([hold({ id: 'a' }), hold({ id: 'b', booking: 'B2', truck_number: '4322' })], led('1261', weekdays('2026-11-02', '2026-11-27'))); return [r.plans.length, r.flags.map(f => `${f.booking} ${f.kind}`).sort()] })(),
  [0, ['B1 reused_job', 'B2 reused_job']])
eq('no linked job: nothing', plan([hold({ job_number: null })], led('1261', ['2026-11-03'])).plans, [])

section('idempotent: a mirrored booking changes nothing')
{
  const rows = [...led('1002', ['2026-11-02']), ...led('1261', weekdays('2026-11-03', '2026-11-27'))]
  const once = mirror([hold()], rows)
  eq('stand-in split, run again', plan(once, rows).plans, [])
  const fiveRows = ['0751', '1106', '4378', '7417', '7450'].flatMap(t => led(t, LATE))
  eq('moved dates, run again', plan(mirror(FIVE, fiveRows), fiveRows).plans, [])
  const short = led('0820', weekdays('2026-11-02', '2026-11-27'))
  eq('shortfall kept, run again', plan(mirror(TWO, short), short).plans, [])
  eq('the sold shape is recorded on every hold', mirror(TWO, short).map(h => soldShapeOf(h.features)), [{ trucks: 2, truckDays: 52 }, { trucks: 2, truckDays: 52 }])
}

section('fully scheduled is judged against what was sold')
{
  const sold = { trucks: 1, truckDays: 20 }
  const hs = [
    { id: 'a', booking: 'B1', market: 'Phoenix, AZ', features: mirroredFeatures(null, { truck: '1002', start: '2026-11-02', end: '2026-11-02', days: 1 }, sold) },
    { id: 'b', booking: 'B1', market: 'Phoenix, AZ', features: mirroredFeatures(null, { truck: '1261', start: '2026-11-03', end: '2026-11-27', days: 19 }, sold) },
  ]
  const st = (a: number, b: number) => new Map([['a', { days: a, of: a, scheduled: true }], ['b', { days: b, of: b, scheduled: true }]])
  eq('every sold day on its runs: scheduled', [...ledMirrorStandings(hs, st(1, 19)).values()].map(s => [s.of, s.scheduled]), [[1, true], [19, true]])
  eq('a day short across the runs: not scheduled, of the 20 sold', [...ledMirrorStandings(hs, st(1, 18)).values()].map(s => [s.of, s.scheduled]), [[1, false], [19, false]])
  eq('a hold never mirrored keeps its own standing', ledMirrorStandings([{ id: 'x', booking: 'B9', market: 'X', features: null }], new Map([['x', { days: 2, of: 3, scheduled: false }]])).get('x'), { days: 2, of: 3, scheduled: false })
}

section('a Salesforce multi-market hold: LED\'s city must be one its label names')
const multi = (over: Partial<FollowHold> = {}) => hold({ market: 'Multi-market: Detroit, Los Angeles, CA', state: null, ...over })
const DET = { market: 'Detroit', state: 'MI', standard_market_name: 'Detroit, MI' }
eq('a city it names: mirrored', shape(mirror([multi()], led('1261', weekdays('2026-11-02', '2026-11-27'), DET))), ['1261 2026-11-02 2026-11-27'])
eq('a city it doesn\'t name: nothing', plan([multi()], led('1261', ['2026-11-03'])).plans, [])
eq('a city in another state than the label gives: nothing',
  plan([multi({ market: 'Multi-market: Detroit, MI, Los Angeles, CA' })], led('1261', ['2026-11-03'], { market: 'Detroit', state: 'TX', standard_market_name: 'Detroit, TX' })).plans, [])
eq('a suburb filed under the labelled city\'s standard market',
  plan([multi({ market: 'Multi-market: New York, NY, Detroit, MI' })], led('1261', ['2026-11-03'], { market: 'Jersey City', state: 'NJ', standard_market_name: 'New York, NY' })).plans.length, 1)
eq('labelCities: a state belongs to the city before it', labelCities('Multi-market: Detroit, Los Angeles, CA'), [{ city: 'detroit', state: null }, { city: 'los angeles', state: 'CA' }])

/**
 * Chain feasibility — pure-function coverage.
 *
 * The back-to-back boundary cases exist because PR #62 review caught an
 * off-by-one there: the outbound gap was counted from campaignEnd instead of
 * the day after, handing a truck a travel day it did not have.
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { getMarketCoords } from '@/lib/marketCoordinates'
import { checkChainFeasibility } from '@/lib/chainFeasibility'
import { buildTruckTimelines, groupDaysIntoJobs, type TruckJob } from '@/lib/truckTimeline'


const TODAY = '2026-09-11'
const C = (m: string) => getMarketCoords(m)!
const okc = C('Oklahoma City, OK')

const job = (start: string, end: string, market: string, state: string, opts: Partial<TruckJob> = {}): TruckJob =>
  ({ start, end, market, state, source: 'HOLD', status: 'HOLD', yieldable: false, ...opts })

function run(label: string, args: {
  start: string; end: string; jobs?: TruckJob[]; gps?: string | null
}) {
  return checkChainFeasibility({
    campaignStart: args.start, campaignEnd: args.end, campaignCoords: okc,
    jobs: args.jobs ?? [],
    currentCoords: args.gps === null ? null : C(args.gps ?? 'Los Angeles, CA'),
    today: TODAY,
  })
}

section('rule 1: can it arrive')
const soon = run('', { start: '2026-09-13', end: '2026-09-17' })
eq('idle LA -> OKC in 2 days: blocked', soon.blockedBy, 'CANNOT_ARRIVE')
eq('not overridable (physics)', soon.overridable, false)
eq('3 transport days needed', soon.inbound.transportDays, 3)
eq('2 days available', soon.inbound.daysAvailable, 2)
eq('idle LA -> OKC in 10 days: feasible', run('', { start: '2026-09-21', end: '2026-09-25' }).feasible, true)

section('release point beats live GPS')
// GPS says Dallas (local to OKC), but the truck works Miami until the 12th.
const fromMiami = run('', {
  start: '2026-09-14', end: '2026-09-18', gps: 'Dallas, TX',
  jobs: [job('2026-09-08', '2026-09-12', 'Miami', 'FL')],
})
eq('origin is the prior job, not GPS', fromMiami.inbound.originLabel, 'Miami, FL')
eq('origin flagged as prior job', fromMiami.inbound.originIsPriorJob, true)
eq('departs day after prior job', fromMiami.inbound.earliestDeparture, '2026-09-13')
eq('Miami->OKC needs repositioning', fromMiami.inbound.transportDays > 0, true)
// Same truck, no prior job: GPS Dallas is local, so no transport at all.
eq('no prior job -> uses GPS', run('', { start: '2026-09-14', end: '2026-09-18', gps: 'Dallas, TX' }).inbound.transportDays, 0)

section('rule 3: does not strand the next job')
const strands = run('', {
  start: '2026-09-21', end: '2026-09-25',
  jobs: [job('2026-09-26', '2026-09-30', 'Seattle', 'WA')],
})
eq('hard hold in Seattle next day: blocked', strands.blockedBy, 'STRANDS_SUCCESSOR')
eq('hard commitment not overridable', strands.overridable, false)
eq('ends 9/25, job starts 9/26 -> 0 free days', strands.successor!.gapDays, 0)
eq('needs more days than the 0 available', strands.successor!.transportDays > 0, true)

const softStrands = run('', {
  start: '2026-09-21', end: '2026-09-25',
  jobs: [job('2026-09-26', '2026-09-30', 'Seattle', 'WA', { status: 'ATT_SOFT', yieldable: true })],
})
eq('soft hold: still blocked', softStrands.feasible, false)
eq('soft hold: OVERRIDABLE', softStrands.overridable, true)

const roomy = run('', {
  start: '2026-09-21', end: '2026-09-25',
  jobs: [job('2026-10-20', '2026-10-25', 'Seattle', 'WA')],
})
eq('successor far in future: feasible', roomy.feasible, true)

section('BOUNDARY: back-to-back scheduling (regression, PR #62 review)')
// The campaign's last day is occupied by the campaign, exactly as a
// predecessor's last day is occupied by the predecessor. Counting the gap from
// campaignEnd hands the truck a travel day it does not have.
const backToBack = (succStart: string) => checkChainFeasibility({
  campaignStart: '2026-09-21', campaignEnd: '2026-09-25', campaignCoords: okc,
  jobs: [job(succStart, '2026-09-30', 'Kansas City', 'MO')],
  currentCoords: okc, today: TODAY,
})
// Kansas City is 298mi from OKC: needs repositioning, exactly 1 transport day.
const zeroGap = backToBack('2026-09-26')
eq('0 free days between campaign and next job', zeroGap.successor!.gapDays, 0)
eq('1 transport day into 0 free days -> BLOCKED', zeroGap.feasible, false)
eq('blocked for stranding', zeroGap.blockedBy, 'STRANDS_SUCCESSOR')

const oneGap = backToBack('2026-09-27')
eq('1 free day between campaign and next job', oneGap.successor!.gapDays, 1)
eq('1 transport day into 1 free day -> allowed', oneGap.feasible, true)

// Inbound and outbound must agree on what counts as a free day.
const inboundSym = checkChainFeasibility({
  campaignStart: '2026-09-21', campaignEnd: '2026-09-25', campaignCoords: okc,
  jobs: [job('2026-09-15', '2026-09-20', 'Kansas City', 'MO')],
  currentCoords: okc, today: TODAY,
})
eq('prior ends 9/20, campaign starts 9/21 -> 0 days available', inboundSym.inbound.daysAvailable, 0)
eq('inbound blocked on the same geometry', inboundSym.feasible, false)

section('deadhead delta: flagged, never priced')
// Prior job Dallas, campaign OKC, successor Seattle.
const delta = run('', {
  start: '2026-09-21', end: '2026-09-25', gps: 'Dallas, TX',
  jobs: [job('2026-09-01', '2026-09-05', 'Dallas', 'TX'), job('2026-10-20', '2026-10-25', 'Seattle', 'WA')],
})
eq('feasible', delta.feasible, true)
eq('successor impact reported', delta.successor !== null, true)
eq('baseline measured from prior job', delta.successor!.baselineDistanceMiles > 0, true)
eq('delta is a number', typeof delta.successor!.deltaCost, 'number')

// Campaign moves the truck TOWARD its next job -> negative delta.
const toward = checkChainFeasibility({
  campaignStart: '2026-09-21', campaignEnd: '2026-09-25',
  campaignCoords: C('Seattle, WA'),
  jobs: [job('2026-09-01', '2026-09-05', 'Miami', 'FL'), job('2026-10-20', '2026-10-25', 'Portland', 'OR')],
  currentCoords: C('Miami, FL'), today: TODAY,
})
eq('moving toward successor -> negative delta', toward.successor!.deltaCost < 0, true)

section('unknown data is surfaced, not dropped')
eq('no origin at all -> UNKNOWN_ORIGIN', run('', { start: '2026-10-21', end: '2026-10-25', gps: null }).blockedBy, 'UNKNOWN_ORIGIN')
const badSucc = run('', {
  start: '2026-09-21', end: '2026-09-25',
  jobs: [job('2026-09-26', '2026-09-30', 'Nowheresville', 'ZZ')],
})
eq('unresolvable successor: check skipped', badSucc.feasible, true)
eq('unresolvable successor: flagged', badSucc.successor!.unresolvedMarket, true)

section('prior-job market that will not geocode')
// Predecessor in an unrecognized market: falls back to GPS (old behavior) but
// must SAY SO, otherwise the regression is invisible.
const fellBack = run('', {
  start: '2026-09-21', end: '2026-09-25', gps: 'Los Angeles, CA',
  jobs: [job('2026-09-01', '2026-09-05', 'Nowheresville', 'ZZ')],
})
eq('flagged as GPS fallback', fellBack.inbound.originFellBackToGps, 'Nowheresville, ZZ')
eq('origin is NOT treated as the prior job', fellBack.inbound.originIsPriorJob, false)
eq('still resolves via GPS', fellBack.inbound.originResolved, true)
eq('departure still gated by the prior job', fellBack.inbound.earliestDeparture, '2026-09-06')
// A resolvable predecessor must NOT set the flag.
eq('no flag when prior market resolves',
   run('', { start: '2026-09-21', end: '2026-09-25', jobs: [job('2026-09-01','2026-09-05','Miami','FL')] })
     .inbound.originFellBackToGps, undefined)

section('timeline grouping')
const grouped = groupDaysIntoJobs([
  { truckNumber: '100', date: '2026-09-01', market: 'Dallas', state: 'TX', program: 'A' },
  { truckNumber: '100', date: '2026-09-02', market: 'Dallas', state: 'TX', program: 'A' },
  { truckNumber: '100', date: '2026-09-03', market: 'Dallas', state: 'TX', program: 'A' },
  { truckNumber: '100', date: '2026-09-04', market: 'Houston', state: 'TX', program: 'A' },
  { truckNumber: '100', date: '2026-09-08', market: 'Dallas', state: 'TX', program: 'A' },
])!.get('100')!
eq('consecutive same-market days merge', grouped.length, 3)
eq('first block spans 3 days', [grouped[0].start, grouped[0].end], ['2026-09-01', '2026-09-03'])
eq('market change splits', grouped[1].market, 'Houston')
eq('date gap splits', grouped[2].start, '2026-09-08')

const merged = buildTruckTimelines(
  [{ truckNumber: '100', date: '2026-09-01', market: 'Dallas', state: 'TX', program: 'A' }],
  [{ truck_number: '100', start_date: '2026-09-10', end_date: '2026-09-12', market: 'Austin', state: 'TX', status: 'ATT_SOFT' }],
).get('100')!
eq('schedule + holds merged in order', merged.map(j => j.source), ['SCHEDULE', 'HOLD'])
eq('schedule jobs never yieldable', merged[0].yieldable, false)
eq('ATT_SOFT hold is yieldable', merged[1].yieldable, true)


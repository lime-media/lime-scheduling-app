/**
 * Ops planner pivot — pure-function coverage.
 * Run with: npm test
 */
import { sheetRows, sortSheet, type SheetColumn } from '@/lib/planner/sheet'
import { eq, section } from './harness'
import { buildEntries, cellText, describeEntry, entryMatches, leaves, marketLabel, normalizeMarket, pivotTree, truckDayTop, plannerRange, plannerWindow, primary, PLANNER_MAX_WEEKS, shiftHours, OPEN_CAPACITY, UNASSIGNED, UNCLASSIFIED, type EntryKind, type PlannerHold, type PlannerNode, type PlannerShift } from '@/lib/planner/build'

section('planner: window')
{
  const w = plannerWindow('2026-09-30') // a Wednesday
  eq('starts the Sunday of last week', w.from, '2026-09-20')
  eq('runs eight weeks: last week, this week, six ahead', w.days.length, 56)
  eq('ends on a Saturday', w.to, '2026-11-14')
  eq('a Sunday is the first day of its week', plannerWindow('2026-09-27').from, '2026-09-20')
  eq('a Saturday is the last day of its week', plannerWindow('2026-10-03').from, '2026-09-20')
}

section('planner: a range the person picks')
{
  eq('widened to whole Sunday-to-Saturday weeks', [plannerRange('2026-10-07', '2026-10-21').from, plannerRange('2026-10-07', '2026-10-21').to], ['2026-10-04', '2026-10-24'])
  eq('already whole weeks: unchanged', [plannerRange('2026-10-04', '2026-10-17').from, plannerRange('2026-10-04', '2026-10-17').to], ['2026-10-04', '2026-10-17'])
  eq('a single day is its week', plannerRange('2026-10-07', '2026-10-07').days.length, 7)
  eq('an end before the start: the start\u2019s week', [plannerRange('2026-10-07', '2026-09-01').from, plannerRange('2026-10-07', '2026-09-01').to], ['2026-10-04', '2026-10-10'])
  eq(`at most ${PLANNER_MAX_WEEKS} weeks`, plannerRange('2026-10-04', '2027-12-31').days.length, PLANNER_MAX_WEEKS * 7)
  eq('every week starts on a Sunday', plannerRange('2026-10-07', '2026-12-30').days.filter((_, i) => i % 7 === 0).every(d => new Date(d + 'T00:00:00Z').getUTCDay() === 0), true)
}

section('planner: hours')
eq('480 minutes is 8', shiftHours(480), 8)
eq('600 is 10, 720 is 12', [shiftHours(600), shiftHours(720)], [10, 12])
eq('a shift a few minutes long still rounds', shiftHours(715), 12)
eq('no duration shows nothing', shiftHours(null), null)

const days = plannerWindow('2026-09-27').days
const shift = (truck: string, date: string, minutes: number | null, driver: string | null, client = 'Toyota', program = 'Toyota Fall'): PlannerShift =>
  ({ truck, date, minutes, driverId: driver, driverName: driver ? `Driver ${driver.toUpperCase()}` : null, client, program, market: 'Dallas, TX' })
const hold = (id: string, truck: string, start: string, end: string, status: PlannerHold['status'], extra: Partial<PlannerHold> = {}): PlannerHold =>
  ({ id, truck, start, end, status, source: 'INTERNAL', client: 'Acme', market: 'Austin, TX', hours: null, opportunityId: null, opportunityName: null, campaignGroupId: null, ...extra })

const entries = buildEntries({
  trucks: ['1261', '1262', '1263'],
  days,
  shifts: [
    shift('1261', '2026-09-28', 480, 'd1'),
    shift('1261', '2026-09-29', 360, 'd1'), shift('1261', '2026-09-29', 360, 'd1'), // a split shift: 6 + 6
    shift('1261', '2026-09-30', 480, 'd1', 'Truck Maintenance', 'Truck Maintenance'),
  ],
  holds: [
    hold('h1', '1262', '2026-10-05', '2026-10-09', 'HOLD'),
    hold('h2', '1262', '2026-10-12', '2026-10-16', 'COMMITTED', { hours: 10, opportunityId: '006A', opportunityName: 'Acme - Fall Push' }),
    hold('h3', '1263', '2026-10-01', '2026-10-31', 'ATT_SOFT'),
    hold('h4', '1263', '2026-10-06', '2026-10-06', 'HOLD', { source: 'CLIENT' }),
  ],
})
const at = (truck: string, date: string) => entries.filter(e => e.truck === truck && e.date === date)

section('planner: what each day shows')
eq('a scheduled day shows its hours', cellText(primary(at('1261', '2026-09-28'))), '8')
eq('split shifts on one day add up', cellText(primary(at('1261', '2026-09-29'))), '12')
eq('maintenance shows M, not hours', [primary(at('1261', '2026-09-30')).kind, cellText(primary(at('1261', '2026-09-30')))], ['MAINTENANCE', 'M'])
eq('a reservation with no hours on file shows R', cellText(primary(at('1262', '2026-10-05'))), 'R')
eq('a committed reservation with quoted hours shows them', [primary(at('1262', '2026-10-12')).kind, cellText(primary(at('1262', '2026-10-12')))], ['COMMITTED', '10'])
eq('a client hold request is a reservation', primary(at('1263', '2026-10-06')).kind, 'RESERVATION')
eq('the AT&T soft hold fills the gap days', primary(at('1263', '2026-10-07')).kind, 'ATT_SOFT')
eq('but not a day something real is on', at('1263', '2026-10-06').map(e => e.kind), ['RESERVATION'])
eq('nothing booked is open', primary(at('1261', '2026-10-20')).kind, 'OPEN')
eq('every truck-day is accounted for', new Set(entries.map(e => `${e.truck}|${e.date}`)).size, 3 * 56)

// A tree as nested labels, for readable expectations.
const shape = (ns: PlannerNode[]): unknown[] => ns.map(n => (n.children.length ? { [n.value]: shape(n.children) } : n.value))
const find = (ns: PlannerNode[], ...path: string[]): PlannerNode => {
  let cur = ns.find(n => n.value === path[0])!
  for (const p of path.slice(1)) cur = cur.children.find(n => n.value === p)!
  return cur
}

section('planner: pivot trees')
{
  const truck = pivotTree(entries, 'truck')
  eq('truck → driver (reservations Unassigned, open days their own row)', shape(truck), [
    { '1261': ['Driver D1', 'Open'] },
    { '1262': [UNASSIGNED, 'Open'] },
    { '1263': [UNASSIGNED, 'Open'] },
  ])
  eq('truck view bars carry the market', marketLabel(primary(find(truck, '1261', 'Driver D1').cells['2026-09-28'])), 'Dallas, TX')
  eq('an AT&T soft hold bar says so', marketLabel(primary(find(truck, '1263', UNASSIGNED).cells['2026-10-07'])), 'AT&T soft hold')

  const driver = pivotTree(entries, 'driver')
  eq('driver → campaign → market → truck', shape(driver).slice(0, 1), [
    { 'Driver D1': [{ 'Toyota Fall': [{ 'Dallas, TX': ['1261'] }] }, { 'Truck Maintenance': [{ 'Dallas, TX': ['1261'] }] }] },
  ])
  eq('reservations have no driver: Unclassified at the top', driver.map(n => n.value), ['Driver D1', UNCLASSIFIED, OPEN_CAPACITY])

  const client = pivotTree(entries, 'client')
  eq('client → campaign → market → asset', shape([find(client, 'Acme')]), [
    { Acme: [{ 'Acme - Fall Push': [{ 'Austin, TX': ['1262'] }] }, { 'Reservation – Acme – Austin, TX': [{ 'Austin, TX': ['1262', '1263'] }] }] },
  ])

  const campaign = pivotTree(entries, 'campaign')
  eq('campaign → market → asset → driver', shape([find(campaign, 'Toyota Fall')]), [{ 'Toyota Fall': [{ 'Dallas, TX': [{ '1261': ['Driver D1'] }] }] }])
  eq('a reservation\'s driver level says Unassigned', leaves(find(campaign, 'Acme - Fall Push')).map(n => n.value), [UNASSIGNED])

  const market = pivotTree(entries, 'market')
  eq('market → truck → campaign', shape([find(market, 'Dallas, TX')]), [{ 'Dallas, TX': [{ '1261': ['Toyota Fall', 'Truck Maintenance'] }] }])
  eq('no market at the top is Unclassified; open capacity last', market.map(n => n.value), ['Austin, TX', 'Dallas, TX', UNCLASSIFIED, OPEN_CAPACITY])

  eq('open capacity lists the trucks', find(market, OPEN_CAPACITY).children.map(n => n.value), ['1261', '1262', '1263'])
  eq('status filters apply', shape(pivotTree(entries, 'truck', new Set(['SCHEDULED']))), [{ '1261': ['Driver D1'] }])
  eq('one spelling per market', normalizeMarket('  Boston ,MA '), 'Boston, MA')
}

section('planner: review fixes')
{
  // Opportunity names with "/" must not merge with deeper paths.
  const slashy = buildEntries({ trucks: ['1'], days: plannerWindow('2026-09-27').days, shifts: [], holds: [
    { id: 'x', truck: '1', start: '2026-10-05', end: '2026-10-05', status: 'HOLD', source: 'INTERNAL', client: 'AT&T', market: 'Dallas, TX', hours: null, opportunityId: '006X', opportunityName: 'AT&T / Hispanic Q3', campaignGroupId: null },
    { id: 'y', truck: '1', start: '2026-10-06', end: '2026-10-06', status: 'HOLD', source: 'INTERNAL', client: 'AT&T', market: 'Dallas, TX', hours: null, opportunityId: '006Y', opportunityName: 'AT&T', campaignGroupId: null },
  ] })
  const byCampaign = pivotTree(slashy, 'campaign').filter(n => n.value !== OPEN_CAPACITY)
  eq('"AT&T / Hispanic Q3" and "AT&T" stay separate campaigns', byCampaign.map(n => n.value), ['AT&T', 'AT&T / Hispanic Q3'])
  eq('and their keys differ', new Set(byCampaign.map(n => n.key)).size, 2)

  const openOff = pivotTree(entries, 'truck', new Set(['SCHEDULED']), ['1261', '1262', '1263'])
  eq('turning Open off keeps idle trucks in the roster', openOff.map(n => n.value), ['1261', '1262', '1263'])

  const strips = truckDayTop(entries)
  eq('the truck strip is truck-wide: 1262 shows its reservation even under another group', strips.get('1262')?.['2026-10-05']?.kind, 'RESERVATION')
  eq('committed with no hours reads C, not R', cellText({ ...primary(at('1262', '2026-10-05')), kind: 'COMMITTED', hours: null }), 'C')
  eq('leaf counts are precomputed', pivotTree(entries, 'truck')[0].leafCount, 2)
  eq('each cell\'s display entry is precomputed', find(pivotTree(entries, 'truck'), '1261', 'Driver D1').top['2026-09-29'].hours, 12)
  eq('search matches any field', [entryMatches(primary(at('1261', '2026-09-28')), 'toyota'), entryMatches(primary(at('1261', '2026-09-28')), 'acme')], [true, false])
  eq('cells describe themselves for screen readers', describeEntry(primary(at('1261', '2026-09-28'))), 'Truck 1261: Scheduled, 8 hours, Toyota Fall, Toyota, Dallas, TX, driver Driver D1')
}

section('planner: Sheet view — one row per driver, program, market, job #, truck')
{
  const all = new Set<EntryKind>(['SCHEDULED', 'MAINTENANCE', 'COMMITTED', 'RESERVATION', 'ATT_SOFT', 'OPEN'])
  const sheetEntries = buildEntries({
    trucks: ['0975', '0673', '4840'],
    days,
    shifts: [
      { ...shift('0975', '2026-09-28', 600, 'aries', '160over90', 'Alloy Build'), market: 'Denver, CO', jobNumber: '26-0119-300' },
      { ...shift('0975', '2026-09-29', 600, 'aries', '160over90', 'Alloy Build'), market: 'Denver, CO', jobNumber: '26-0119-300' },
      { ...shift('4840', '2026-09-28', 480, 'dwight', 'FSI', 'FSI'), market: 'Washington DC', jobNumber: '26-0013-300' },
      { ...shift('0673', '2026-09-30', 600, 'dwight', '160over90', 'LED DRIVE DAY'), market: 'St George, UT', jobNumber: '26-2000-300' },
      { ...shift('0673', '2026-10-01', 480, null, 'Lime', 'Truck Maintenance'), jobNumber: '00-0000-000' },
    ],
    holds: [hold('r1', '4840', '2026-10-05', '2026-10-06', 'HOLD', { opportunityName: 'Acme - Fall', jobNumber: null })],
  })
  const rows = sheetRows(sheetEntries, new Set<EntryKind>(['SCHEDULED', 'MAINTENANCE', 'RESERVATION']))
  const alloy = rows.find(r => r.program === 'Alloy Build')!
  eq('consecutive days of one assignment are one row', [rows.filter(r => r.program === 'Alloy Build').length, Object.keys(alloy.cells).sort()], [1, ['2026-09-28', '2026-09-29']])
  eq('the row carries every column', [alloy.driver, alloy.program, alloy.market, alloy.job, alloy.truck], ['Driver ARIES', 'Alloy Build', 'Denver, CO', '26-0119-300', '0975'])
  eq('a placeholder job number is no job number', rows.find(r => r.program === 'Truck Maintenance')?.job, '')
  eq('a reservation has no driver', rows.find(r => r.program.includes('Acme'))?.driver, '')
  eq('a drive day shows D', cellText(rows.find(r => r.program === 'LED DRIVE DAY')!.top['2026-09-30']), 'D')
  eq('kinds switched off are left out', rows.some(r => r.program === OPEN_CAPACITY), false)
  eq('open days are one row per truck when shown', sheetRows(sheetEntries, all).filter(r => r.program === OPEN_CAPACITY).map(r => r.truck).sort(), ['0673', '0975', '4840'])

  const by = (col: SheetColumn, dir: 'asc' | 'desc' = 'asc') => sortSheet(rows, col, dir).map(r => r[col])
  eq('sorts by driver, blanks last', by('driver'), ['Driver ARIES', 'Driver DWIGHT', 'Driver DWIGHT', '', ''])
  eq('descending keeps blanks last', by('driver', 'desc'), ['Driver DWIGHT', 'Driver DWIGHT', 'Driver ARIES', '', ''])
  eq('sorts by truck as numbers', by('truck'), ['0673', '0673', '0975', '4840', '4840'])
  eq('sorts by job #', by('job').filter(Boolean), ['26-0013-300', '26-0119-300', '26-2000-300'])
  eq('ties fall back to the other columns in order', sortSheet(rows, 'driver', 'asc').filter(r => r.driver === 'Driver DWIGHT').map(r => r.program), ['FSI', 'LED DRIVE DAY'])
}

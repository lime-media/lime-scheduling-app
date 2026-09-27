/**
 * Ops planner pivot — pure-function coverage.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { buildEntries, cellText, leaves, marketLabel, normalizeMarket, pivotTree, plannerWindow, primary, shiftHours, OPEN_CAPACITY, UNASSIGNED, UNCLASSIFIED, type PlannerHold, type PlannerNode, type PlannerShift } from '@/lib/planner/build'

section('planner: window')
{
  const w = plannerWindow('2026-09-27') // a Sunday
  eq('starts the Monday of last week', w.from, '2026-09-14')
  eq('runs eight weeks: last week, this week, six ahead', w.days.length, 56)
  eq('ends on a Sunday', w.to, '2026-11-08')
  eq('a Monday anchors the same way', plannerWindow('2026-09-21').from, '2026-09-14')
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
  eq('group rows count trucks per day (1262 reserved, 1263 requested)', find(client, 'Acme').trucksByDay['2026-10-06'], 2)
  eq('status filters apply', shape(pivotTree(entries, 'truck', new Set(['SCHEDULED']))), [{ '1261': ['Driver D1'] }])
  eq('one spelling per market', normalizeMarket('  Boston ,MA '), 'Boston, MA')
}

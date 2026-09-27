/**
 * Ops planner pivot — pure-function coverage.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { buildEntries, cellText, normalizeMarket, pivotEntries, plannerWindow, primary, shiftHours, OPEN_CAPACITY, UNCLASSIFIED, type PlannerHold, type PlannerShift } from '@/lib/planner/build'

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
eq('a client hold is a request', primary(at('1263', '2026-10-06')).kind, 'REQUEST')
eq('the AT&T soft hold fills the gap days', primary(at('1263', '2026-10-07')).kind, 'ATT_SOFT')
eq('but not a day something real is on', at('1263', '2026-10-06').map(e => e.kind), ['REQUEST'])
eq('nothing booked is open', primary(at('1261', '2026-10-20')).kind, 'OPEN')
eq('every truck-day is accounted for', new Set(entries.map(e => `${e.truck}|${e.date}`)).size, 3 * 56)

section('planner: pivots')
{
  const byDriver = pivotEntries(entries, 'driver')
  eq('driver pivot: the driver, then Unclassified, then open capacity', byDriver.map(g => g.label), ['Driver D1', UNCLASSIFIED, OPEN_CAPACITY])
  eq('reservations have no driver, so they are Unclassified', byDriver.find(g => g.label === UNCLASSIFIED)!.rows.map(r => r.truck), ['1262', '1263'])
  const byCampaign = pivotEntries(entries, 'campaign')
  eq('campaign: program for booked, opportunity or reservation otherwise',
    byCampaign.map(g => g.label).filter(l => l !== OPEN_CAPACITY).sort(),
    ['AT&T soft hold', 'Acme - Fall Push', 'Reservation – Acme – Austin, TX', 'Toyota Fall', 'Truck Maintenance'])
  const byClient = pivotEntries(entries, 'client')
  eq('client pivot rows are one per truck', byClient.find(g => g.label === 'Acme')!.rows.map(r => r.truck), ['1262', '1263'])
  eq('a client row only holds that client\'s days', Object.keys(byClient.find(g => g.label === 'Toyota')!.rows[0].cells).sort(), ['2026-09-28', '2026-09-29'])
  eq('truck pivot: one row per truck', pivotEntries(entries, 'truck')[0].rows.map(r => r.truck), ['1261', '1262', '1263'])
  eq('status filters apply', pivotEntries(entries, 'truck', new Set(['SCHEDULED']))[0].rows.map(r => r.truck), ['1261'])
}

section('planner: market pivot')
{
  const byMarket = pivotEntries(entries, 'market')
  eq('markets, then Unclassified (the soft hold has none), then open capacity', byMarket.map(g => g.label), ['Austin, TX', 'Dallas, TX', UNCLASSIFIED, OPEN_CAPACITY])
  eq('Dallas holds the scheduled truck', byMarket.find(g => g.label === 'Dallas, TX')!.rows.map(r => r.truck), ['1261'])
  eq('Austin holds both reservation trucks', byMarket.find(g => g.label === 'Austin, TX')!.rows.map(r => r.truck), ['1262', '1263'])
  eq('one spelling per market', normalizeMarket('  Boston ,MA '), 'Boston, MA')
}

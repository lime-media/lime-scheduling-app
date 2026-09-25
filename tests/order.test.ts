/**
 * Multi-market order routing — pure-function coverage.
 *
 * Share, chain and assign each get a case that pins the decision a dispatcher
 * would make by hand, plus the shortfall the quote reports when the fleet
 * cannot cover a market.
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import {
  canShare, buildJobs, canFollow, chainJobs, planOrder, trucksByLine, legsByLine,
  DEFAULT_ENGINE, type EngineSettings, type OrderLine,
} from '@/lib/planning/order'
import { freeFrom, type PlanTruck } from '@/lib/planning/planner'
import type { TruckJob } from '@/lib/truckTimeline'

const S: EngineSettings = { ...DEFAULT_ENGINE, today: '2026-09-25' }

const CITY = {
  dal: { market: 'Dallas', lat: 32.78, lng: -96.80 },
  ftw: { market: 'Fort Worth', lat: 32.75, lng: -97.33 },     // ~31 mi from Dallas
  hou: { market: 'Houston', lat: 29.76, lng: -95.37 },        // ~225 mi straight, ~281 road
  den: { market: 'Denver', lat: 39.74, lng: -104.99 },        // ~660 mi from Dallas
}

const line = (id: string, city: keyof typeof CITY, startDate: string, endDate: string, trucks = 1, daysPerWeek = 3, hours = 12): OrderLine =>
  ({ id, ...CITY[city], startDate, endDate, trucks, daysPerWeek, hours })

const truck = (truckNumber: string, city: keyof typeof CITY, jobs: TruckJob[] = []): PlanTruck =>
  ({ truckNumber, jobs, gps: { lat: CITY[city].lat, lng: CITY[city].lng }, gpsLabel: CITY[city].market })

const busy = (start: string, end: string, city: keyof typeof CITY): TruckJob =>
  ({ start, end, market: CITY[city].market, state: 'TX', lat: CITY[city].lat, lng: CITY[city].lng, source: 'SCHEDULE', yieldable: false })

// ---------------------------------------------------------------------------
section('order: which markets can share a truck')

const dal3 = line('dal', 'dal', '2026-10-12', '2026-11-08')
const ftw3 = line('ftw', 'ftw', '2026-10-12', '2026-11-08')
eq('3 + 3 days, 31 mi apart: share', canShare(dal3, ftw3, S), true)
eq('5 + 5 days cannot fit one week', canShare({ ...dal3, daysPerWeek: 5 }, { ...ftw3, daysPerWeek: 5 }, S), false)
eq('3 + 4 days leaves no travel day', canShare(dal3, { ...ftw3, daysPerWeek: 4 }, S), false)
eq('Dallas-Houston is past the 250 road-mile hop', canShare(dal3, line('hou', 'hou', '2026-10-12', '2026-11-08'), S), false)
eq('a longer hop limit lets them share', canShare(dal3, line('hou', 'hou', '2026-10-12', '2026-11-08'), { ...S, hopLimitRoadMiles: 300 }), true)
eq('dates that never overlap cannot share', canShare(dal3, line('ftw', 'ftw', '2026-11-09', '2026-11-30'), S), false)

// ---------------------------------------------------------------------------
section('order: jobs')
{
  const two = buildJobs([{ ...dal3, trucks: 2 }, { ...ftw3, trucks: 2 }], S).jobs
  eq('2 + 2 shareable trucks become 2 shared jobs', two.map(j => j.lines.length), [2, 2])
  const uneven = buildJobs([{ ...dal3, trucks: 3 }, ftw3], S).jobs
  eq('3 + 1: one shared, two on their own', uneven.map(j => j.lines.length).sort(), [1, 1, 2])
  eq('shared job records its hop in road miles', uneven.find(j => j.lines.length === 2)!.hopRoadMiles, 39)
}

// ---------------------------------------------------------------------------
section('order: one truck, one market after another')
{
  const [dal] = buildJobs([line('dal', 'dal', '2026-10-05', '2026-10-18', 1, 5, 8)], S).jobs
  const [hou] = buildJobs([line('hou', 'hou', '2026-10-20', '2026-11-01', 1, 5, 8)], S).jobs
  const [den] = buildJobs([line('den', 'den', '2026-10-20', '2026-11-01', 1, 5, 8)], S).jobs
  eq('Dallas then Houston (inside the service area): one truck', canFollow(dal, hou, S), true)
  eq('Dallas then Denver needs 2 travel days, has 1', canFollow(dal, den, S), false)
  eq('chained into one truck', chainJobs([dal, hou], S).length, 1)
  eq('Denver needs its own truck', chainJobs([dal, den], S).length, 2)
}

// ---------------------------------------------------------------------------
section('order: choosing real trucks')
{
  const order = [line('dal', 'dal', '2026-10-12', '2026-11-08', 1, 5, 8)]
  const plan = planOrder(order, [truck('9001', 'den'), truck('1261', 'dal')], S)
  eq('the truck already in Dallas is used', plan.trucks.map(t => t.truckNumber), ['1261'])
  eq('no transport to get there', plan.trucks[0].legs[0].transportDays, 0)
  eq('nothing short', plan.shortfalls, [])

  const booked = planOrder(order, [truck('1261', 'dal', [busy('2026-10-20', '2026-10-25', 'dal')]), truck('9001', 'den')], S)
  eq('a truck booked mid-campaign is skipped', booked.trucks.map(t => t.truckNumber), ['9001'])
  eq('the Denver truck is repositioned, and priced', booked.trucks[0].legs[0].transportDays > 0 && booked.trucks[0].legs[0].absorbedCost > 0, true)

  const shared = planOrder([dal3, ftw3], [truck('1261', 'dal'), truck('1262', 'ftw')], S)
  eq('Dallas + Fort Worth at 3 days each: one truck, two drivers', shared.trucks.map(t => [t.truckNumber, t.drivers]).length, 1)
  eq('the other truck is left for other clients', shared.poolSize - shared.trucks.length, 1)
  eq('each market names the market it shares with', trucksByLine(shared).get('dal')![0].sharedWith, 'Fort Worth')
  eq('the only move arrives at the first market', [...legsByLine(shared).keys()].length, 1)
}

// ---------------------------------------------------------------------------
section('order: shortfalls')
{
  const fleet = [truck('1261', 'dal'), truck('1262', 'dal', [busy('2026-10-01', '2026-10-20', 'dal')])]
  const plan = planOrder([line('dal', 'dal', '2026-10-12', '2026-11-08', 3, 5, 8)], fleet, S)
  eq('3 wanted, 1 free for the whole run', plan.trucks.length, 1)
  eq('2 short, reported against the market', plan.shortfalls.map(s => [s.market, s.missing]), [['Dallas', 2]])
  eq('earliest a truck not already in this order could start', plan.shortfalls[0].earliestPossibleStart, '2026-10-21')
  eq('freeFrom agrees', freeFrom(fleet[1].jobs, '2026-10-12', '2026-11-08'), '2026-10-21')
}

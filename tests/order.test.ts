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
  canShare, buildJobs, canFollow, chainJobs, planOrder, trucksByLine, legsByLine, rotationStints, lineActivationDays,
  rotation, workDays, deliveredTruckDays, fitTruck,
  DEFAULT_ENGINE, type EngineSettings, type OrderLine,
} from '@/lib/planning/order'
import { addDays, freeFrom, type PlanTruck } from '@/lib/planning/planner'
import { fitNames, lineFeatures } from '@/lib/planning/booking'
import type { LineQuote } from '@/lib/planning/quote'
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
  eq('the move names its truck and where it comes from', [booked.trucks[0].legs[0].truckNumber, booked.trucks[0].legs[0].fromLabel, booked.trucks[0].legs[0].fromKind], ['9001', 'Denver', 'GPS'])
  eq('and how far it drives', Math.round(booked.trucks[0].legs[0].distanceMiles / 10) * 10, 660)

  const shared = planOrder([dal3, ftw3], [truck('1261', 'dal'), truck('1262', 'ftw')], S)
  eq('Dallas + Fort Worth at 3 days each: one truck, two drivers', shared.trucks.map(t => [t.truckNumber, t.drivers]).length, 1)
  eq('the other truck is left for other clients', shared.poolSize - shared.trucks.length, 1)
  eq('each market names the market it shares with', trucksByLine(shared).get('dal')![0].sharedWith, 'Fort Worth')
  eq('and the weekly hop between them', trucksByLine(shared).get('ftw')![0].hopRoadMiles, 39)
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

// ---------------------------------------------------------------------------
section('order: holds by market for a shared truck')
{
  // Mon Oct 12 - Sun Oct 25: two weeks, Dallas and Fort Worth 3 days a week each.
  const a = line('dal', 'dal', '2026-10-12', '2026-10-25')
  const b = line('ftw', 'ftw', '2026-10-12', '2026-10-25')
  const [job] = buildJobs([a, b], S).jobs
  const st = rotationStints(job)
  eq('Dallas, Fort Worth, Dallas: back-to-back stretches', st.map(x => [x.market, x.start, x.end]), [
    ['Dallas', '2026-10-12', '2026-10-15'],      // Mon-Wed, Thu travel
    ['Fort Worth', '2026-10-16', '2026-10-22'],  // Fri-Sun, Mon-Wed, Thu travel
    ['Dallas', '2026-10-23', '2026-10-25'],      // Fri-Sun
  ])
  eq('each stretch but the last ends with the drive to the other', st.map(x => x.travelTo), ['Fort Worth', 'Dallas', null])
  const days = (id: string) => st.filter(x => x.lineId === id).reduce((n, x) => n + (Math.round((Date.parse(x.end) - Date.parse(x.start)) / 864e5) + 1) - (x.travelTo ? 1 : 0), 0)
  eq('each market gets its 3 days in each of the 2 weeks', [days('dal'), days('ftw')], [6, 6])
  const noOverlap = st.every((x, i) => i === 0 || x.start > st[i - 1].end)
  eq('no two holds overlap', noOverlap, true)
  eq('no day uncovered', st.every((x, i) => i === 0 || x.start === new Date(Date.parse(st[i - 1].end) + 864e5).toISOString().slice(0, 10)), true)

  const lead = line('dal', 'dal', '2026-10-05', '2026-10-25')
  const [j2] = buildJobs([lead, b], S).jobs
  eq('a week on Dallas alone comes before the rotation', rotationStints(j2)[0], { lineId: 'dal', market: 'Dallas', start: '2026-10-05', end: '2026-10-15', travelTo: 'Fort Worth' })
  eq('a market on its own truck: one hold', rotationStints(buildJobs([line('den', 'den', '2026-10-12', '2026-11-08', 1, 5, 8)], S).jobs[0]).length, 1)
}

section('order: billed days')
eq('3 days a week, two weeks', lineActivationDays({ startDate: '2026-10-12', endDate: '2026-10-25', daysPerWeek: 3 }), 6)
eq('3 days a week, part week', lineActivationDays({ startDate: '2026-10-12', endDate: '2026-10-21', daysPerWeek: 3 }), 6)
eq('Mon-Fri as the single quote', lineActivationDays({ startDate: '2026-09-01', endDate: '2026-09-14', daysPerWeek: 5 }), 10)
eq('every day as the single quote', lineActivationDays({ startDate: '2026-09-01', endDate: '2026-09-03', daysPerWeek: 7 }), 3)

// ---------------------------------------------------------------------------
section('order: billing matches what the rotation delivers, for any span')
{
  let mismatches = 0, overlaps = 0, gaps = 0, wrongEnd = 0, shortWeeks = 0
  for (let cal = 1; cal <= 60; cal++) {
    for (const offset of [0, 3]) {
      const a = line('dal', 'dal', '2026-10-12', addDays('2026-10-12', cal - 1))
      const b = line('ftw', 'ftw', addDays('2026-10-12', offset), addDays('2026-10-12', cal - 1 + offset))
      if (!canShare(a, b, S)) continue
      const [job] = buildJobs([a, b], S).jobs
      if (job.lines.length !== 2) continue
      const days = rotation(job)
      // Billing reads the same WORK days the holds are cut from.
      const plan = { trucks: [{ truckNumber: 'T', jobs: [job], legs: [], drivers: 2 }], shortfalls: [], poolSize: 1 }
      const billed = deliveredTruckDays(plan)
      const worked = workDays(job)
      for (const id of ['dal', 'ftw']) if (billed.get(id) !== worked.get(id) || worked.get(id) !== days.filter(d => d.kind === 'WORK' && d.lineId === id).length) mismatches++
      const st = rotationStints(job)
      for (let i = 1; i < st.length; i++) { if (st[i].start <= st[i - 1].end) overlaps++; if (st[i].start !== addDays(st[i - 1].end, 1)) gaps++ }
      if (st[0].start !== job.start || st[st.length - 1].end !== job.end) gaps++
      // Work only happens inside the stretch held for that market.
      for (const d of days) if (d.kind === 'WORK' && !st.some(x => x.lineId === d.lineId && x.start <= d.date && d.date <= x.end)) mismatches++
      // Where the job ends, for chaining, is where the truck actually is.
      const lastDay = days[days.length - 1]
      const endsIn = lastDay.kind === 'TRAVEL' ? job.lines.find(l => l.id !== lastDay.lineId)!.id : lastDay.lineId
      if (job.last.id !== endsIn) wrongEnd++
      // Every full week of the overlap gives each market exactly its 3 days.
      const ov = offset
      for (let w = 0; ov + (w + 1) * 7 <= cal; w++) {
        const week = days.filter(d => d.date >= addDays(b.startDate, w * 7) && d.date < addDays(b.startDate, (w + 1) * 7) && d.kind === 'WORK')
        if (week.filter(d => d.lineId === 'dal').length !== 3 || week.filter(d => d.lineId === 'ftw').length !== 3) shortWeeks++
      }
    }
  }
  eq('billed days = worked days = WORK days in the rotation', mismatches, 0)
  eq('holds never overlap', overlaps, 0)
  eq('holds leave no gap', gaps, 0)
  eq('the job ends where the truck is (10 and 21-day spans included)', wrongEnd, 0)
  eq('each full week: 3 days in each market', shortWeeks, 0)

  const a = line('dal', 'dal', '2026-10-12', '2026-10-21')
  const b = line('ftw', 'ftw', '2026-10-12', '2026-10-21')
  const plan = planOrder([a, b], [truck('1261', 'dal'), truck('1262', 'ftw')], S)
  const d = deliveredTruckDays(plan)
  eq('Oct 12-21 shared: each market is billed the days it gets, not a formula', [d.get('dal'), d.get('ftw')], [3, 6])
}

section('order: the next booking is checked from where the chain ends')
{
  const miami = { start: '2026-10-21', end: '2026-10-30', market: 'Miami', state: 'FL', lat: 25.76, lng: -80.19, source: 'SCHEDULE' as const, yieldable: false }
  const [den] = buildJobs([line('den', 'den', '2026-10-12', '2026-10-20', 1, 5, 8)], S).jobs
  eq('a hard booking in Miami the next day cannot be stranded', fitTruck(truck('1261', 'dal', [miami]), [den], S), null)
  eq('a soft hold there can be (the rep decides)', fitTruck(truck('1261', 'dal', [{ ...miami, source: 'HOLD', yieldable: true }]), [den], S) !== null, true)
  eq('with time to get there, fine', fitTruck(truck('1261', 'dal', [{ ...miami, start: '2026-10-28', end: '2026-11-05' }]), [den], S) !== null, true)
}

section('order: a chain no truck can take stays as whole as it can')
{
  // Three back-to-back Dallas jobs; the only truck is booked for the third.
  const l1 = line('a', 'dal', '2026-10-05', '2026-10-11', 1, 5, 8)
  const l2 = line('b', 'dal', '2026-10-12', '2026-10-18', 1, 5, 8)
  const l3 = line('c', 'dal', '2026-10-19', '2026-10-25', 1, 5, 8)
  const plan = planOrder([l1, l2, l3], [truck('1261', 'dal', [busy('2026-10-19', '2026-10-25', 'dal')])], S)
  eq('the truck keeps the first two jobs together', plan.trucks.map(t => t.jobs.length), [2])
  eq('only the third is short', plan.shortfalls.map(x => x.lineId), ['c'])
}

section('booking: what a client can see, and Salesforce text')
{
  const lq = { dailyRate: 1500, hourSurcharge: 300, truckDays: 6, trucks: 1, activationDays: 6, calendarDays: 10, daysPerWeek: 3, hours: 12, baseMedia: 10800,
    shadowFencing: 900, shadowFencingFloored: false, smartDirectional: 0, deviceId: 0, transport: { outcome: 'ABSORBED', billed: 0, absorbedCost: 4321 },
    arrivals: [{ truckNumber: '9999', from: 'Denver', fromKind: 'GPS', miles: 660, transportDays: 2, outOfMarket: true, charge: 0, ourCost: 4321 }] } as unknown as LineQuote
  const json = JSON.stringify(lineFeatures(lq, { shadowFencing: true, smartDirectional: false, deviceId: false }))
  eq('no truck origins, our costs or fleet counts in the hold breakdown', ['9999', 'Denver', '4321', 'ourCost', 'absorbed', 'poolSize', 'leftForOthers', 'arrivals'].filter(t => json.includes(t)), [])
  eq('it is the breakdown the hold pages render', Object.keys(JSON.parse(json)).includes('truckDays') && Object.keys(JSON.parse(json)).includes('baseMedia'), true)

  const names = Array.from({ length: 44 }, (_, i) => `Market Number ${i + 1}, TX`)
  const fit = fitNames(names, 255)
  eq('Markets__c fits 255', fit.length <= 255, true)
  eq('and is cut between names, with a count', /; \+\d+ more$/.test(fit) && fit.split('; ').slice(0, -1).every(n => names.includes(n)), true)
  eq('short lists are untouched', fitNames(['Dallas, TX', 'Fort Worth, TX'], 255), 'Dallas, TX; Fort Worth, TX')
}

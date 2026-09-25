/**
 * Multi-market order routing — the logistics brain behind a multi-market quote.
 *
 * An order is a set of lines: N trucks in a market, for a date range, on a
 * weekly pattern (days per week × hours per day). The engine finds the way to
 * fulfil every line with the fewest trucks, the least transport and the least
 * driving, which also leaves the most trucks free for other clients.
 *
 *   1. SHARE  — two lines' truck-slots share one truck when the truck can
 *               alternate between them within a week: both markets within the
 *               hop limit, overlapping dates, and days A + days B + 1 travel
 *               day <= 7 (e.g. 3 + 3 + 1). Maximum matching: most shares,
 *               then shortest hops.
 *   2. CHAIN  — jobs that follow each other in time go on one truck when it
 *               can get from one to the next in time. Minimum path cover by
 *               assignment: fewest chains (trucks), then least transport.
 *   3. ASSIGN — each chain gets a real truck: free for the whole chain, able
 *               to arrive from its release point, not stranding its next
 *               booking — the same chain rules as every quote. Minimum-cost
 *               assignment on the transport we absorb. A chain no truck can
 *               take is split into its jobs and tried again.
 *
 * Pure: the fleet (trucks, jobs, positions) is passed in.
 */

import { haversineDistance } from '@/lib/marketCoordinates'
import { checkChainFeasibility, type Coords } from '@/lib/chainFeasibility'
import { findWindowClash } from '@/lib/truckTimeline'
import { absorbedLegCost, needsRepositioning, transportDaysFromDistance } from '@/lib/pricing/transport'
import { countActivationDays, countCalendarDays } from '@/lib/pricing/schedule'
import { maxPairing, type MatchEdge } from './matching'
import { minCostAssignment } from './assignment'
import { addDays, daysBetween, freeFrom, type PlanTruck } from './planner'

export type OrderLine = {
  id: string
  market: string
  lat: number
  lng: number
  startDate: string
  endDate: string
  trucks: number
  daysPerWeek: number
  hours: number
}

export type EngineSettings = {
  today: string
  /** Two markets can share a truck week to week within this many road miles. */
  hopLimitRoadMiles: number
  roadFactor: number
  serviceAreaMiles?: number
}

/**
 * Weekly schedules a market can ask for. 5, 6 and 7 are the single-market
 * quote's Mon-Fri, Mon-Sat and every day. 3 is three days a week on a
 * rotation, which lets one truck alternate between two nearby markets.
 */
export const SCHEDULES = [5, 6, 7, 3] as const

/** Billed days for a line: the single-market rule, or 3 per week on rotation. */
export function lineActivationDays(line: Pick<OrderLine, 'startDate' | 'endDate' | 'daysPerWeek'>): number {
  if (line.daysPerWeek !== 3) return countActivationDays(line.startDate, line.endDate, line.daysPerWeek)
  const calendar = countCalendarDays(line.startDate, line.endDate)
  return Math.floor(calendar / 7) * 3 + Math.min(3, calendar % 7)
}

export const DEFAULT_ENGINE: Omit<EngineSettings, 'today'> = { hopLimitRoadMiles: 250, roadFactor: 1.25 }

/** One truck's worth of one line. */
type Slot = { line: OrderLine; index: number }

/** What one truck does for one stretch: one line, or two lines shared week to week. */
export type Job = {
  id: string
  lines: OrderLine[]
  start: string
  end: string
  /** Where the truck must be when the job starts, and where it ends up. */
  first: OrderLine
  last: OrderLine
  /** Road miles of the weekly hop between two shared lines; 0 if not shared. */
  hopRoadMiles: number
}

export type Leg = {
  truckNumber: string
  fromLabel: string
  /** Where the truck starts the move: its last job before this order, its live position, or an earlier market in this order. */
  fromKind: 'PRIOR_JOB' | 'GPS' | 'THIS_ORDER'
  toLineId: string
  distanceMiles: number
  transportDays: number
  absorbedCost: number
}

export type TruckPlan = {
  truckNumber: string
  jobs: Job[]
  /** Every move the truck makes: into the first job, then between jobs. */
  legs: Leg[]
  drivers: number
}

export type Shortfall = {
  lineId: string
  market: string
  missing: number
  /** Earliest date some truck could start this line and run to its end date, if any. */
  earliestPossibleStart: string | null
}

export type OrderPlan = {
  trucks: TruckPlan[]
  shortfalls: Shortfall[]
  /** Trucks available to this order before it was planned. */
  poolSize: number
}

const TRUCK_COST = 1e7   // a whole extra truck always outweighs any transport saving
const MILE_TIEBREAK = 1e-3

function roadMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }, roadFactor: number): number {
  return haversineDistance(a.lat, a.lng, b.lat, b.lng) * roadFactor
}

function straight(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return haversineDistance(a.lat, a.lng, b.lat, b.lng)
}

function moveDays(miles: number, s: EngineSettings): number {
  return needsRepositioning(miles, s.serviceAreaMiles) ? transportDaysFromDistance(miles) : 0
}

function moveCost(miles: number, s: EngineSettings): number {
  const days = moveDays(miles, s)
  return days > 0 ? absorbedLegCost(days) : 0
}

// ---------------------------------------------------------------------------
// 1. Share
// ---------------------------------------------------------------------------

export function canShare(a: OrderLine, b: OrderLine, s: EngineSettings): boolean {
  return a.id !== b.id
    && a.daysPerWeek + b.daysPerWeek + 1 <= 7
    && a.startDate <= b.endDate && b.startDate <= a.endDate
    && roadMiles(a, b, s.roadFactor) <= s.hopLimitRoadMiles
}

export function buildJobs(lines: OrderLine[], s: EngineSettings): { jobs: Job[]; approximateClusters: number } {
  const slots: Slot[] = lines.flatMap(line => Array.from({ length: line.trucks }, (_, index) => ({ line, index })))
  const edges: MatchEdge[] = []
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      if (canShare(slots[i].line, slots[j].line, s)) edges.push({ a: i, b: j, miles: roadMiles(slots[i].line, slots[j].line, s.roadFactor) })
    }
  }
  const { pairs, greedyClusters } = maxPairing(slots.length, edges)

  const jobs: Job[] = []
  const used = new Set<number>()
  for (const p of pairs) {
    used.add(p.a); used.add(p.b)
    const [x, y] = [slots[p.a].line, slots[p.b].line]
    const first = x.startDate <= y.startDate ? x : y
    const last = x.endDate >= y.endDate ? x : y
    jobs.push({
      id: `${x.id}#${slots[p.a].index}+${y.id}#${slots[p.b].index}`,
      lines: [first, first === x ? y : x],
      start: first.startDate,
      end: last.endDate,
      first, last,
      hopRoadMiles: Math.round(p.miles),
    })
  }
  slots.forEach((sl, i) => {
    if (used.has(i)) return
    jobs.push({ id: `${sl.line.id}#${sl.index}`, lines: [sl.line], start: sl.line.startDate, end: sl.line.endDate, first: sl.line, last: sl.line, hopRoadMiles: 0 })
  })
  jobs.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))
  return { jobs, approximateClusters: greedyClusters }
}

// ---------------------------------------------------------------------------
// 2. Chain
// ---------------------------------------------------------------------------

/** Can one truck finish `x` and still reach `y` by its start? */
export function canFollow(x: Job, y: Job, s: EngineSettings): boolean {
  const miles = straight(x.last, y.first)
  return daysBetween(addDays(x.end, 1), y.start) >= moveDays(miles, s)
}

export function chainJobs(jobs: Job[], s: EngineSettings): Job[][] {
  const n = jobs.length
  if (n === 0) return []
  // Rows: each job as a predecessor. Columns: each job as a successor, then
  // n "no successor" columns. Every row ending a chain costs a truck.
  const cost = jobs.map((x, i) => [
    ...jobs.map((y, j) => {
      if (i === j || !canFollow(x, y, s)) return Infinity
      const miles = straight(x.last, y.first)
      return moveCost(miles, s) + miles * MILE_TIEBREAK
    }),
    ...jobs.map(() => TRUCK_COST),
  ])
  const { colForRow } = minCostAssignment(cost)
  const next = new Map<number, number>()
  const hasPrev = new Set<number>()
  colForRow.forEach((c, i) => { if (c >= 0 && c < n) { next.set(i, c); hasPrev.add(c) } })

  const chains: Job[][] = []
  for (let i = 0; i < n; i++) {
    if (hasPrev.has(i)) continue
    const chain: Job[] = []
    for (let k: number | undefined = i; k !== undefined; k = next.get(k)) chain.push(jobs[k])
    chains.push(chain)
  }
  return chains
}

// ---------------------------------------------------------------------------
// 3. Assign
// ---------------------------------------------------------------------------

type Fit = { cost: number; inboundMiles: number; inboundDays: number; originLabel: string; fromPriorJob: boolean }

/** Can this truck take this whole chain? Same chain rules as every quote. */
export function fitTruck(truck: PlanTruck, chain: Job[], s: EngineSettings): Fit | null {
  const start = chain[0].start
  const end = chain.reduce((m, j) => (j.end > m ? j.end : m), chain[0].end)
  if (findWindowClash(truck.jobs, start, end)) return null

  const firstCoords: Coords = { lat: chain[0].first.lat, lng: chain[0].first.lng }
  const lastJob = chain[chain.length - 1]
  const inbound = checkChainFeasibility({
    campaignStart: start, campaignEnd: end, campaignCoords: firstCoords,
    jobs: truck.jobs, currentCoords: truck.gps, today: s.today, serviceAreaMiles: s.serviceAreaMiles,
  })
  if (inbound.blockedBy === 'CANNOT_ARRIVE' || inbound.blockedBy === 'UNKNOWN_ORIGIN') return null
  // The next booking is reached from where the chain ENDS, not where it starts.
  const outbound = checkChainFeasibility({
    campaignStart: start, campaignEnd: end, campaignCoords: { lat: lastJob.last.lat, lng: lastJob.last.lng },
    jobs: truck.jobs, currentCoords: truck.gps, today: s.today, serviceAreaMiles: s.serviceAreaMiles,
  })
  if (outbound.blockedBy === 'STRANDS_SUCCESSOR' && !outbound.overridable) return null

  const miles = inbound.inbound.distanceMiles
  const days = inbound.inbound.transportDays
  return {
    cost: (days > 0 ? absorbedLegCost(days) : 0) + miles * MILE_TIEBREAK,
    inboundMiles: Math.round(miles),
    inboundDays: days,
    originLabel: inbound.inbound.originIsPriorJob ? inbound.inbound.originLabel : truck.gpsLabel || 'current position',
    fromPriorJob: Boolean(inbound.inbound.originIsPriorJob),
  }
}

function toTruckPlan(truck: PlanTruck, chain: Job[], fit: Fit, s: EngineSettings): TruckPlan {
  const legs: Leg[] = [{
    truckNumber: truck.truckNumber,
    fromLabel: fit.originLabel,
    fromKind: fit.fromPriorJob ? 'PRIOR_JOB' : 'GPS',
    toLineId: chain[0].first.id,
    distanceMiles: fit.inboundMiles,
    transportDays: fit.inboundDays,
    absorbedCost: fit.inboundDays > 0 ? absorbedLegCost(fit.inboundDays) : 0,
  }]
  for (let k = 1; k < chain.length; k++) {
    const miles = straight(chain[k - 1].last, chain[k].first)
    const days = moveDays(miles, s)
    legs.push({ truckNumber: truck.truckNumber, fromLabel: chain[k - 1].last.market, fromKind: 'THIS_ORDER', toLineId: chain[k].first.id, distanceMiles: Math.round(miles), transportDays: days, absorbedCost: days > 0 ? absorbedLegCost(days) : 0 })
  }
  return { truckNumber: truck.truckNumber, jobs: chain, legs, drivers: Math.max(...chain.map(j => j.lines.length)) }
}

export function planOrder(lines: OrderLine[], trucks: PlanTruck[], s: EngineSettings): OrderPlan & { approximateClusters: number } {
  const { jobs, approximateClusters } = buildJobs(lines, s)
  const chains = chainJobs(jobs, s)

  const assigned: TruckPlan[] = []
  let pool = [...trucks]

  const assignRound = (units: Job[][]): Job[][] => {
    if (units.length === 0 || pool.length === 0) return units
    const fits = units.map(c => pool.map(t => fitTruck(t, c, s)))
    const { colForRow } = minCostAssignment(fits.map(row => row.map(f => (f ? f.cost : Infinity))))
    const leftover: Job[][] = []
    const taken = new Set<number>()
    colForRow.forEach((j, i) => {
      const f = j >= 0 ? fits[i][j] : null
      if (f) { assigned.push(toTruckPlan(pool[j], units[i], f, s)); taken.add(j) } else leftover.push(units[i])
    })
    pool = pool.filter((_, j) => !taken.has(j))
    return leftover
  }

  // Whole chains first; a chain no truck can take is split into its jobs.
  const unchained = assignRound(chains)
  const unserved = assignRound(unchained.flatMap(c => (c.length > 1 ? c.map(j => [j]) : [c])))

  // What could not be done, per line, with the nearest feasible alternative.
  // Only trucks this order has not already taken can make up a shortfall.
  const missing = new Map<string, number>()
  for (const c of unserved) for (const j of c) for (const l of j.lines) missing.set(l.id, (missing.get(l.id) ?? 0) + 1)
  const shortfalls: Shortfall[] = [...missing].map(([lineId, count]) => {
    const line = lines.find(l => l.id === lineId)!
    let earliest: string | null = null
    for (const t of pool) {
      const f = freeFrom(t.jobs, line.startDate, line.endDate)
      if (!f) continue
      // It still has to get there: from its last job before it frees up, else its live position.
      const prev = t.jobs.filter(j => j.end < f && j.lat !== undefined && j.lng !== undefined).sort((a, b) => b.end.localeCompare(a.end))[0]
      const from = prev ? { lat: prev.lat!, lng: prev.lng! } : t.gps
      if (!from) continue
      const arrive = addDays(prev ? addDays(prev.end, 1) : s.today, moveDays(straight(from, line), s))
      const start = arrive > f ? arrive : f
      if (start <= line.endDate && (!earliest || start < earliest)) earliest = start
    }
    return { lineId, market: line.market, missing: count, earliestPossibleStart: earliest && earliest > line.startDate ? earliest : null }
  })

  assigned.sort((a, b) => a.jobs[0].start.localeCompare(b.jobs[0].start) || a.truckNumber.localeCompare(b.truckNumber))
  return { trucks: assigned, shortfalls, poolSize: trucks.length, approximateClusters }
}

// ---------------------------------------------------------------------------
// Rotation: where a shared truck is, day by day
// ---------------------------------------------------------------------------

/** A stretch one truck spends in one market; `travelTo` when it ends with the drive to the other. */
export type Stint = { lineId: string; market: string; start: string; end: string; travelTo: string | null }

/**
 * The days a job's truck spends in each market, as back-to-back stretches that
 * never overlap, so each can carry its own hold.
 *
 * A shared truck alternates on a two-week cycle, so each market gets its days
 * every calendar week and the truck drives only once a week:
 *
 *   week 1: A A A → B B B B      (A's days, travel day, B's days)
 *   week 2: B B B → A A A A      (B's days, travel day, A's days)
 *
 * Days outside the two lines' overlap go to whichever line is running. The
 * travel day is kept on the stretch it leaves, so the truck is never shown
 * free between markets.
 */
export function rotationStints(job: Job): Stint[] {
  if (job.lines.length === 1) {
    const l = job.lines[0]
    return [{ lineId: l.id, market: l.market, start: job.start, end: job.end, travelTo: null }]
  }
  const [a, b] = job.lines
  const overlapStart = a.startDate > b.startDate ? a.startDate : b.startDate
  const TRAVEL = 'travel'
  const where = (d: string): string => {
    const inA = a.startDate <= d && d <= a.endDate
    const inB = b.startDate <= d && d <= b.endDate
    if (inA && !inB) return a.id
    if (inB && !inA) return b.id
    const k = daysBetween(overlapStart, d)
    const pos = k % 7
    const [first, second] = Math.floor(k / 7) % 2 === 0 ? [a, b] : [b, a]
    return pos < first.daysPerWeek ? first.id : pos === first.daysPerWeek ? TRAVEL : second.id
  }

  const byId = new Map([[a.id, a], [b.id, b]])
  const out: Stint[] = []
  for (let d = job.start; d <= job.end; d = addDays(d, 1)) {
    const at = where(d)
    const cur = out[out.length - 1]
    if (at === TRAVEL) {
      if (cur) { cur.end = d; cur.travelTo = byId.get(cur.lineId === a.id ? b.id : a.id)!.market }
      continue
    }
    if (cur && cur.lineId === at && !cur.travelTo) { cur.end = d; continue }
    out.push({ lineId: at, market: byId.get(at)!.market, start: d, end: d, travelTo: null })
  }
  return out
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

/** Legs that arrive at each line, for pricing that line's transport. */
export function legsByLine(plan: OrderPlan): Map<string, Leg[]> {
  const out = new Map<string, Leg[]>()
  for (const t of plan.trucks) for (const l of t.legs) out.set(l.toLineId, [...(out.get(l.toLineId) ?? []), l])
  return out
}

/** Trucks serving each line, with the line they share with, if any. */
export function trucksByLine(plan: OrderPlan): Map<string, { truckNumber: string; sharedWith: string | null; hopRoadMiles: number }[]> {
  const out = new Map<string, { truckNumber: string; sharedWith: string | null; hopRoadMiles: number }[]>()
  for (const t of plan.trucks) {
    for (const j of t.jobs) {
      for (const l of j.lines) {
        const other = j.lines.find(x => x.id !== l.id)
        out.set(l.id, [...(out.get(l.id) ?? []), { truckNumber: t.truckNumber, sharedWith: other ? other.market : null, hopRoadMiles: j.hopRoadMiles }])
      }
    }
  }
  return out
}

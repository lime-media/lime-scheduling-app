/**
 * Multi-market planner — the pure core.
 *
 * Question it answers: to cover N areas every week, which trucks do it, from
 * when, and what does it cost us to get them there?
 *
 *   areas ──pair (3x12) or not (5x8)──► routes
 *   routes × trucks ──chain rules──► earliest workable start per pair
 *   earliest starts ──assignment──► the start-date decision: for each date,
 *                                   the transport we absorb to be live by then
 *
 * Feasibility is the same chain check every quote uses (lib/chainFeasibility):
 * a truck starts from its release point — the market of its last job before the
 * start, else live GPS — needs the same transport days, and may not strand a
 * later booking. Nothing here re-derives those rules.
 *
 * Repositioning is priced with absorbedLegCost(), the engine's cost to us of a
 * leg we absorb, because a program this size clears both absorption tests. Legs
 * inside the service area cost nothing, as in every quote.
 */

import { haversineDistance } from '@/lib/marketCoordinates'
import { checkChainFeasibility, type Coords } from '@/lib/chainFeasibility'
import { findWindowClash, type TruckJob } from '@/lib/truckTimeline'
import { absorbedLegCost } from '@/lib/pricing/transport'
import { computeQuote } from '@/lib/pricing/engine'
import type { RateOverrides } from '@/lib/pricing/config'
import { maxPairing } from './matching'
import { minCostAssignment } from './assignment'
import type { Area } from './areas'

// ---------------------------------------------------------------------------
// Models and settings
// ---------------------------------------------------------------------------

export type CoverageModel = '3x12' | '5x8'

export const MODELS: Record<CoverageModel, { daysPerWeek: number; hours: number; label: string }> = {
  '3x12': { daysPerWeek: 3, hours: 12, label: 'Three 12-hour days' },
  '5x8': { daysPerWeek: 5, hours: 8, label: 'Five 8-hour days' },
}

export type PlanSettings = {
  model: CoverageModel
  /** Earliest date any route may start. */
  planStart: string
  /** Trucks must be free from their start through this date. */
  planThrough: string
  today: string
  /** Paired areas must be within this many ROAD miles (straight line × roadFactor). */
  hopLimitRoadMiles: number
  roadFactor: number
  /** How far past planStart a route may slip waiting for a truck. */
  maxSlipDays: number
  serviceAreaMiles?: number
}

export const DEFAULT_SETTINGS: Omit<PlanSettings, 'planStart' | 'planThrough' | 'today'> = {
  model: '3x12',
  hopLimitRoadMiles: 250,
  roadFactor: 1.25,
  maxSlipDays: 60,
}

export type PlanTruck = {
  truckNumber: string
  jobs: TruckJob[]
  gps: Coords | null
  gpsLabel: string
}

export type Route = {
  id: string
  areaIds: string[]
  name: string
  /** Road miles between the two areas; 0 for a single-area route. */
  hopRoadMiles: number
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().split('T')[0]
}

export function daysBetween(from: string, to: string): number {
  return Math.round((new Date(to + 'T00:00:00Z').getTime() - new Date(from + 'T00:00:00Z').getTime()) / 86400000)
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

/**
 * Trucks on the most recent month of soft holds, by start month.
 *
 * AT&T soft holds are loaded a month at a time and older months are rarely
 * expired, so "every recent soft hold" over-counts: the roster rotates and a
 * truck held in June may have been handed back. The latest month is the
 * current roster.
 */
export function latestSoftHoldTrucks(holds: { truck_number: string; start_date: Date }[]): Set<string> {
  if (holds.length === 0) return new Set()
  const month = (d: Date) => d.toISOString().slice(0, 7)
  const latest = holds.map(h => month(h.start_date)).sort().pop()!
  return new Set(holds.filter(h => month(h.start_date) === latest).map(h => h.truck_number))
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function buildRoutes(areas: Area[], settings: PlanSettings): { routes: Route[]; greedyClusters: number } {
  if (settings.model === '5x8') {
    // Five days in one area leaves no room for a second: one truck per area.
    return {
      routes: areas.map(a => ({ id: a.id, areaIds: [a.id], name: a.name, hopRoadMiles: 0 })),
      greedyClusters: 0,
    }
  }
  const edges = []
  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      const road = haversineDistance(areas[i].lat, areas[i].lng, areas[j].lat, areas[j].lng) * settings.roadFactor
      if (road <= settings.hopLimitRoadMiles) edges.push({ a: i, b: j, miles: road })
    }
  }
  const { pairs, greedyClusters } = maxPairing(areas.length, edges)
  const paired = new Set<number>()
  const routes: Route[] = []
  for (const p of pairs) {
    paired.add(p.a); paired.add(p.b)
    const [x, y] = [areas[p.a], areas[p.b]]
    routes.push({ id: `${x.id}+${y.id}`, areaIds: [x.id, y.id], name: `${x.name} + ${y.name}`, hopRoadMiles: Math.round(p.miles) })
  }
  areas.forEach((a, i) => {
    if (!paired.has(i)) routes.push({ id: a.id, areaIds: [a.id], name: a.name, hopRoadMiles: 0 })
  })
  routes.sort((r1, r2) => (r1.areaIds.length === 1 ? 1 : 0) - (r2.areaIds.length === 1 ? 1 : 0) || r1.hopRoadMiles - r2.hopRoadMiles)
  return { routes, greedyClusters }
}

// ---------------------------------------------------------------------------
// Per truck: when is it free, and when could it start a given route?
// ---------------------------------------------------------------------------

/** First date on/after planStart from which the truck has nothing booked through planThrough. */
export function freeFrom(jobs: TruckJob[], planStart: string, planThrough: string): string | null {
  let d = planStart
  for (let guard = 0; guard < 400; guard++) {
    const clash = findWindowClash(jobs, d, planThrough)
    if (!clash) return d
    d = addDays(clash.end, 1)
    if (d > planThrough) return null
  }
  return null
}

export type Candidate = {
  start: string
  /** The area the truck drives to first. */
  firstAreaId: string
  originLabel: string
  originIsPriorJob: boolean
  distanceMiles: number
  transportDays: number
  repositionCost: number
}

export function earliestStart(
  truck: PlanTruck,
  route: Route,
  areasById: Map<string, Area>,
  settings: PlanSettings,
): Candidate | null {
  const free = freeFrom(truck.jobs, settings.planStart, settings.planThrough)
  if (!free) return null
  const limit = addDays(settings.planStart, settings.maxSlipDays)

  let best: Candidate | null = null
  for (const areaId of route.areaIds) {
    const area = areasById.get(areaId)!
    let d = free
    for (let guard = 0; guard < 20 && d <= limit; guard++) {
      const chain = checkChainFeasibility({
        campaignStart: d,
        campaignEnd: settings.planThrough,
        campaignCoords: { lat: area.lat, lng: area.lng },
        jobs: truck.jobs,
        currentCoords: truck.gps,
        today: settings.today,
        serviceAreaMiles: settings.serviceAreaMiles,
      })
      if (chain.feasible) {
        const miles = chain.inbound.distanceMiles
        const cand: Candidate = {
          start: d,
          firstAreaId: areaId,
          originLabel: chain.inbound.originIsPriorJob ? chain.inbound.originLabel : truck.gpsLabel || 'current position',
          originIsPriorJob: chain.inbound.originIsPriorJob,
          distanceMiles: Math.round(miles),
          transportDays: chain.inbound.transportDays,
          // One derivation: the chain check already decided the transport
          // days (0 inside the service area), so the cost uses exactly those.
          repositionCost: chain.inbound.transportDays > 0 ? absorbedLegCost(chain.inbound.transportDays) : 0,
        }
        if (!best || cand.start < best.start || (cand.start === best.start && cand.distanceMiles < best.distanceMiles)) best = cand
        break
      }
      if (chain.blockedBy === 'CANNOT_ARRIVE') {
        // Push the start out by exactly the travel days it is short.
        d = addDays(d, Math.max(1, chain.inbound.transportDays - chain.inbound.daysAvailable))
        continue
      }
      break // UNKNOWN_ORIGIN or STRANDS_SUCCESSOR — no later start fixes these
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Assignment and the start-date decision
// ---------------------------------------------------------------------------
//
// The business question is not "how far should a truck drive to save a day".
// It is "how much transport are we willing to absorb to have this live by a
// given date". So nothing here trades days against miles. For each date, the
// assignment serves as many routes as that date allows at the lowest absorbed
// transport cost, and the table of dates is the decision.

/**
 * Dollars decide. Among trucks that cost the same (typically several inside
 * the service area, at $0), the earlier start wins, then the shorter drive.
 * The weights are far too small to ever outweigh a dollar.
 */
const DAY_TIEBREAK = 1e-3
const MILE_TIEBREAK = 1e-6

export type RouteAssignment = {
  routeId: string
  routeName: string
  hopRoadMiles: number
  truckNumber: string | null
  start: string | null
  firstAreaId: string | null
  originLabel: string | null
  distanceMiles: number
  transportDays: number
  repositionCost: number
}

export type PhasedMilestone = { date: string; routesLive: number }

export type AssignmentOutcome = {
  feasible: boolean
  shortBy: number
  deadheadMiles: number
  repositionCost: number
  movesOverServiceArea: number
  assignments: RouteAssignment[]
  milestones: PhasedMilestone[]
}

type Matrix = (Candidate | null)[][]

export function candidateMatrix(routes: Route[], trucks: PlanTruck[], areasById: Map<string, Area>, settings: PlanSettings): Matrix {
  return routes.map(r => trucks.map(t => earliestStart(t, r, areasById, settings)))
}

/**
 * Assign trucks so every route is live by `deadline`, at the lowest absorbed
 * transport cost. Each route starts as soon as its truck can.
 */
export function assign(
  routes: Route[],
  trucks: PlanTruck[],
  matrix: Matrix,
  deadline: string,
  planStart: string,
): AssignmentOutcome {
  const cost = matrix.map(row => row.map(c =>
    c && c.start <= deadline
      ? c.repositionCost + daysBetween(planStart, c.start) * DAY_TIEBREAK + c.distanceMiles * MILE_TIEBREAK
      : Infinity,
  ))
  const { colForRow, unserved } = minCostAssignment(cost)

  const assignments: RouteAssignment[] = routes.map((r, i) => {
    const j = colForRow[i]
    const c = j >= 0 ? matrix[i][j] : null
    return {
      routeId: r.id,
      routeName: r.name,
      hopRoadMiles: r.hopRoadMiles,
      truckNumber: c ? trucks[j].truckNumber : null,
      start: c ? c.start : null,
      firstAreaId: c?.firstAreaId ?? null,
      originLabel: c?.originLabel ?? null,
      distanceMiles: c?.distanceMiles ?? 0,
      transportDays: c?.transportDays ?? 0,
      repositionCost: c?.repositionCost ?? 0,
    }
  })
  const live = assignments.map(a => a.start).filter((d): d is string => d !== null).sort()
  const milestones = [...new Set(live)].map(d => ({ date: d, routesLive: live.filter(x => x <= d).length }))
  return {
    feasible: unserved === 0,
    shortBy: unserved,
    deadheadMiles: assignments.reduce((s, a) => s + a.distanceMiles, 0),
    repositionCost: Math.round(assignments.reduce((s, a) => s + a.repositionCost, 0)),
    movesOverServiceArea: assignments.filter(a => a.repositionCost > 0).length,
    assignments,
    milestones,
  }
}

export type DateOption = {
  date: string
  /** Trucks with nothing booked from this date through plan-through. */
  trucksClear: number
  /**
   * Every route live by this date, each starting as soon as its truck can.
   * (Holding every route back to launch together on this date would use the
   * same trucks at the same cost, so it is not a separate option.)
   */
  liveBy: AssignmentOutcome
}

export type DateDecision = {
  options: DateOption[]
  /** First date by which every route can be live. */
  firstFullLiveBy: string | null
  /** Earliest date at which the transport we absorb reaches its lowest. */
  cheapestDate: string | null
}

/**
 * The start-date decision table.
 *
 * Cost does not fall steadily as the date moves out: it can hold flat for
 * weeks and then drop when one well-placed truck frees up. So every date on
 * which any truck becomes available is evaluated, through the slip limit, and
 * the cheapest is found from all of them — never inferred from two equal rows.
 * The table shows weekly dates, the first full-coverage date, and the
 * cheapest date, and stops after the cheapest.
 */
export function dateOptions(
  routes: Route[],
  trucks: PlanTruck[],
  matrix: Matrix,
  settings: PlanSettings,
): DateDecision {
  const clearBy = (date: string) =>
    trucks.filter(t => { const f = freeFrom(t.jobs, settings.planStart, settings.planThrough); return f !== null && f <= date }).length
  const limit = addDays(settings.planStart, settings.maxSlipDays)

  // Cost can only change on a date when some candidate becomes available.
  const candidateDates = [...new Set(matrix.flat().filter((c): c is Candidate => c !== null).map(c => c.start))]
    .filter(d => d <= limit)
    .sort()
  const outcomes = new Map<string, AssignmentOutcome>()
  const outcome = (d: string) => {
    let o = outcomes.get(d)
    if (!o) { o = assign(routes, trucks, matrix, d, settings.planStart); outcomes.set(d, o) }
    return o
  }

  let firstFullLiveBy: string | null = null
  let cheapestDate: string | null = null
  let cheapest = Infinity
  for (const d of candidateDates) {
    const o = outcome(d)
    if (!o.feasible) continue
    firstFullLiveBy ??= d
    if (o.repositionCost < cheapest) { cheapest = o.repositionCost; cheapestDate = d }
  }

  const dates = new Set<string>()
  for (let d = settings.planStart; d <= limit; d = addDays(d, 7)) dates.add(d)
  if (firstFullLiveBy) dates.add(firstFullLiveBy)
  if (cheapestDate) dates.add(cheapestDate)
  const last = cheapestDate ?? limit

  const options: DateOption[] = [...dates]
    .filter(d => d <= last)
    .sort()
    .map(date => ({ date, trucksClear: clearBy(date), liveBy: outcome(date) }))
  return { options, firstFullLiveBy, cheapestDate }
}

// ---------------------------------------------------------------------------
// Pricing — the rate card, via the same engine as every quote
// ---------------------------------------------------------------------------

export type ProgramPrice = {
  model: CoverageModel
  areas: number
  truckDaysPerWeek: number
  truckHoursPerWeek: number
  effectiveDailyRate: number
  perTruckHour: number
  baseMediaPerWeek: number
  shadowFencingPerWeek: number
  smartDirectionalPerWeek: number
  totalPerWeek: number
  totalPerQuarter: number
}

/** Price a weekly program over a 13-week quarter, then express it per week. */
export function priceProgram(
  areaCount: number,
  model: CoverageModel,
  opts: { smartDirectional?: boolean; rateOverrides?: RateOverrides | null } = {},
): ProgramPrice {
  const { daysPerWeek, hours } = MODELS[model]
  const weeks = 13
  const q = computeQuote({
    truckCount: areaCount,
    days: daysPerWeek * weeks,
    operatingHours: hours,
    includeSmartDirectional: opts.smartDirectional ?? false,
    rateOverrides: opts.rateOverrides ?? null,
  })
  const per = (x: number) => Math.round(x / weeks)
  return {
    model,
    areas: areaCount,
    truckDaysPerWeek: areaCount * daysPerWeek,
    truckHoursPerWeek: areaCount * daysPerWeek * hours,
    effectiveDailyRate: q.effectiveDailyRate,
    perTruckHour: Math.round((q.effectiveDailyRate / hours) * 100) / 100,
    baseMediaPerWeek: per(q.better.baseMedia),
    shadowFencingPerWeek: per(q.better.shadowFencing),
    smartDirectionalPerWeek: per(q.better.smartDirectional),
    totalPerWeek: per(q.better.total),
    totalPerQuarter: Math.round(q.better.total),
  }
}

// ---------------------------------------------------------------------------
// Capacity — what the commitment leaves for everyone else
// ---------------------------------------------------------------------------

export type CapacityInput = {
  activeTrucks: number
  maintenanceReserve: number
  reservedLow: number
  reservedHigh: number
  renewingTrucks: number
  programTrucks: number
}

export function capacityLeft(c: CapacityInput): { low: number; high: number } {
  const base = c.activeTrucks - c.maintenanceReserve - c.renewingTrucks - c.programTrucks
  return { low: base - c.reservedHigh, high: base - c.reservedLow }
}

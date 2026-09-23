/**
 * Multi-market planner — the pure core.
 *
 * Question it answers: to cover N areas every week, which trucks do it, from
 * when, and what does it cost us to get them there?
 *
 *   areas ──pair (3x12) or not (5x8)──► routes
 *   routes × trucks ──chain rules──► earliest workable start per pair
 *   earliest starts ──assignment──► start options (uniform dates, phased)
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
import { absorbedLegCost, needsRepositioning, transportDaysFromDistance } from '@/lib/pricing/transport'
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
  /** Assignment trade-off: one day of delay is worth this many deadhead miles. */
  latePenaltyMilesPerDay: number
  serviceAreaMiles?: number
}

export const DEFAULT_SETTINGS: Omit<PlanSettings, 'planStart' | 'planThrough' | 'today'> = {
  model: '3x12',
  hopLimitRoadMiles: 250,
  roadFactor: 1.25,
  maxSlipDays: 60,
  latePenaltyMilesPerDay: 40,
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
          repositionCost: needsRepositioning(miles, settings.serviceAreaMiles) ? absorbedLegCost(transportDaysFromDistance(miles)) : 0,
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
// Assignment and start options
// ---------------------------------------------------------------------------

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

export type AssignmentOutcome = {
  feasible: boolean
  shortBy: number
  deadheadMiles: number
  repositionCost: number
  movesOverServiceArea: number
  assignments: RouteAssignment[]
}

type Matrix = (Candidate | null)[][]

export function candidateMatrix(routes: Route[], trucks: PlanTruck[], areasById: Map<string, Area>, settings: PlanSettings): Matrix {
  return routes.map(r => trucks.map(t => earliestStart(t, r, areasById, settings)))
}

/**
 * Assign trucks to routes.
 *
 * uniform: every route starts on `startDate`; only trucks that can make it qualify.
 * phased:  each route starts as soon as its truck can; lateness is traded
 *          against deadhead at latePenaltyMilesPerDay.
 */
export function assign(
  routes: Route[],
  trucks: PlanTruck[],
  matrix: Matrix,
  settings: PlanSettings,
  mode: { kind: 'uniform'; startDate: string } | { kind: 'phased' },
): AssignmentOutcome {
  const cost = matrix.map(row => row.map(c => {
    if (!c) return Infinity
    if (mode.kind === 'uniform') return c.start <= mode.startDate ? c.distanceMiles : Infinity
    return c.distanceMiles + settings.latePenaltyMilesPerDay * Math.max(0, daysBetween(settings.planStart, c.start))
  }))
  const { colForRow, unserved } = minCostAssignment(cost)

  const assignments: RouteAssignment[] = routes.map((r, i) => {
    const j = colForRow[i]
    const c = j >= 0 ? matrix[i][j] : null
    return {
      routeId: r.id,
      routeName: r.name,
      hopRoadMiles: r.hopRoadMiles,
      truckNumber: c ? trucks[j].truckNumber : null,
      start: c ? (mode.kind === 'uniform' ? mode.startDate : c.start) : null,
      firstAreaId: c?.firstAreaId ?? null,
      originLabel: c?.originLabel ?? null,
      distanceMiles: c?.distanceMiles ?? 0,
      transportDays: c?.transportDays ?? 0,
      repositionCost: c?.repositionCost ?? 0,
    }
  })
  return {
    feasible: unserved === 0,
    shortBy: unserved,
    deadheadMiles: assignments.reduce((s, a) => s + a.distanceMiles, 0),
    repositionCost: Math.round(assignments.reduce((s, a) => s + a.repositionCost, 0)),
    movesOverServiceArea: assignments.filter(a => a.repositionCost > 0).length,
    assignments,
  }
}

export type StartOption = {
  label: string
  startDate: string | null
  trucksClear: number
  spare: number
  outcome: AssignmentOutcome
}

export type PhasedMilestone = { date: string; routesLive: number }

/**
 * The start-options table: a handful of uniform start dates, the first date
 * every route could start together, and the phased plan.
 */
export function startOptions(
  routes: Route[],
  trucks: PlanTruck[],
  matrix: Matrix,
  settings: PlanSettings,
): { options: StartOption[]; phased: AssignmentOutcome; milestones: PhasedMilestone[]; firstFullStart: string | null } {
  const clearBy = (date: string) =>
    trucks.filter(t => { const f = freeFrom(t.jobs, settings.planStart, settings.planThrough); return f !== null && f <= date }).length

  // Earliest uniform date that serves every route: scan the distinct dates on
  // which a candidate becomes available.
  const dates = [...new Set(matrix.flat().filter((c): c is Candidate => c !== null).map(c => c.start))].sort()
  let firstFullStart: string | null = null
  for (const d of dates) {
    if (assign(routes, trucks, matrix, settings, { kind: 'uniform', startDate: d }).feasible) { firstFullStart = d; break }
  }

  const uniformDates = [0, 7, 14, 21].map(n => addDays(settings.planStart, n))
  if (firstFullStart && !uniformDates.includes(firstFullStart)) uniformDates.push(firstFullStart)
  uniformDates.sort()

  const options: StartOption[] = uniformDates.map(d => {
    const outcome = assign(routes, trucks, matrix, settings, { kind: 'uniform', startDate: d })
    const clear = clearBy(d)
    return {
      label: d === firstFullStart ? 'Earliest full start' : 'All routes together',
      startDate: d,
      trucksClear: clear,
      spare: clear - routes.length,
      outcome,
    }
  })

  const phased = assign(routes, trucks, matrix, settings, { kind: 'phased' })
  const live = phased.assignments.map(a => a.start).filter((d): d is string => d !== null).sort()
  const milestones: PhasedMilestone[] = []
  for (const d of [...new Set(live)]) milestones.push({ date: d, routesLive: live.filter(x => x <= d).length })
  options.push({
    label: 'Phased',
    startDate: live[0] ?? null,
    trucksClear: trucks.length,
    spare: trucks.length - routes.length,
    outcome: phased,
  })
  return { options, phased, milestones, firstFullStart }
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

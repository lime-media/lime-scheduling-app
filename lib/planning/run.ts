/**
 * Run a multi-market plan end to end: load the fleet and its history, build
 * routes, find every truck's earliest workable start, and produce the start
 * options, pricing and capacity tables the planner tab shows.
 */

import { resolveDefaultRateOverrides, businessDaysBetween } from '@/lib/pricing/resolvers'
import { MIN_LEAD_BUSINESS_DAYS_TO_ABSORB } from '@/lib/pricing/transport'
import { HIDDEN_TRUCKS } from '@/lib/availabilityEngine'
import type { Area } from './areas'
import { DEFAULT_RULES, loadPlanningFleet, type ReservedTruck } from './fleet'
import { loadUsageHistory, type UsageSummary } from './history'
import {
  DEFAULT_SETTINGS, buildRoutes, candidateMatrix, dateOptions, priceProgram, capacityLeft,
  type CoverageModel, type PlanSettings, type Route, type DateOption, type ProgramPrice,
} from './planner'

export type PlanRequest = {
  areas: Area[]
  model: CoverageModel
  planStart: string
  planThrough: string
  hopLimitRoadMiles?: number
  reserveSoftHolds?: boolean
  /** Treat AT&T's Alloy Build as renewing, keeping its trucks. */
  alloyRenews?: boolean
  maintenanceReserve?: number
  /** Planning range for AT&T's weekly trucks. */
  reservedLow?: number
  reservedHigh?: number
  smartDirectional?: boolean
}

export type CapacityRow = { model: CoverageModel; programTrucks: number; leftLow: number; leftHigh: number }

export type PlanResponse = {
  settings: PlanSettings
  routes: Route[]
  /** The decision: for each date, the transport we absorb to be live by it. */
  dateOptions: DateOption[]
  firstFullLiveBy: string | null
  cheapestDate: string | null
  /** Index into dateOptions of the first date with every route live. */
  defaultOption: number
  pricing: { chosen: ProgramPrice; other: ProgramPrice }
  capacity: {
    activeTrucks: number
    maintenanceReserve: number
    reservedLow: number
    reservedHigh: number
    renewingTrucks: number
    /** The Alloy Build renewal toggle was on for this plan. */
    renewingOn: boolean
    rows: CapacityRow[]
    history: Omit<UsageSummary, 'weeks'>
  }
  fleet: { candidates: number; reserved: ReservedTruck[]; withoutPosition: number }
  warnings: string[]
}

const OTHER: Record<CoverageModel, CoverageModel> = { '3x12': '5x8', '5x8': '3x12' }

export async function runPlan(req: PlanRequest): Promise<PlanResponse> {
  const today = new Date().toISOString().split('T')[0]
  const settings: PlanSettings = {
    ...DEFAULT_SETTINGS,
    model: req.model,
    planStart: req.planStart < today ? today : req.planStart,
    planThrough: req.planThrough,
    today,
    hopLimitRoadMiles: req.hopLimitRoadMiles ?? DEFAULT_SETTINGS.hopLimitRoadMiles,
  }
  const rules = {
    ...DEFAULT_RULES,
    reserveSoftHolds: req.reserveSoftHolds ?? DEFAULT_RULES.reserveSoftHolds,
    renewingPrograms: req.alloyRenews ? ['Alloy Build'] : [],
  }

  const [fleet, history, rateOverrides] = await Promise.all([
    loadPlanningFleet({ today, planThrough: settings.planThrough, rules }),
    loadUsageHistory({ today, reservedClients: rules.reservedClients, renewingPrograms: ['Alloy Build'], hiddenTrucks: HIDDEN_TRUCKS }),
    resolveDefaultRateOverrides(),
  ])

  const areasById = new Map(req.areas.map(a => [a.id, a]))
  const { routes, greedyClusters } = buildRoutes(req.areas, settings)
  const matrix = candidateMatrix(routes, fleet.trucks, areasById, settings)
  const decision = dateOptions(routes, fleet.trucks, matrix, settings)

  // Capacity: what each model's commitment leaves for other clients.
  const renewingTrucks = fleet.reserved.filter(r => !r.reason.startsWith('AT&T soft')).length
  const maintenanceReserve = req.maintenanceReserve ?? 7
  const reservedLow = req.reservedLow ?? 20
  const reservedHigh = req.reservedHigh ?? 25
  const otherRoutes = buildRoutes(req.areas, { ...settings, model: OTHER[req.model] }).routes.length
  const rows: CapacityRow[] = ([
    [req.model, routes.length],
    [OTHER[req.model], otherRoutes],
  ] as [CoverageModel, number][]).map(([model, programTrucks]) => {
    const left = capacityLeft({ activeTrucks: fleet.activeTrucks, maintenanceReserve, reservedLow, reservedHigh, renewingTrucks, programTrucks })
    return { model, programTrucks, leftLow: left.low, leftHigh: left.high }
  })

  const warnings: string[] = []
  if (req.alloyRenews && renewingTrucks === 0) {
    warnings.push('Alloy Build is marked as renewing, but no truck is currently on an Alloy Build job, so none are held back. Check the program name in the schedule.')
  }
  if (rules.reserveSoftHolds && !fleet.reserved.some(r => r.reason.startsWith('AT&T soft'))) {
    warnings.push('No AT&T soft holds are on file, so no AT&T trucks are held back. The capacity table still subtracts the AT&T range you entered.')
  }
  if (greedyClusters > 0) {
    warnings.push(`${greedyClusters} cluster(s) of areas were too large to pair exactly within the time allowed. The truck count is still the minimum, but the pairings may not have the shortest possible hops. A smaller pairing distance gives an exact answer.`)
  }
  if (!decision.firstFullLiveBy) {
    const last = decision.options[decision.options.length - 1]
    warnings.push(`${last?.liveBy.shortBy ?? routes.length} route(s) have no truck that can start within ${settings.maxSlipDays} days of ${settings.planStart}.`)
  }
  const firstStart = decision.options.flatMap(o => o.liveBy.assignments.map(a => a.start)).filter((d): d is string => !!d).sort()[0]
  if (firstStart) {
    const lead = businessDaysBetween(new Date(), new Date(firstStart + 'T00:00:00Z'))
    if (lead < MIN_LEAD_BUSINESS_DAYS_TO_ABSORB) {
      warnings.push(`The first route starts ${lead} business days out; transport is only absorbed with ${MIN_LEAD_BUSINESS_DAYS_TO_ABSORB}+. Move the start to keep repositioning absorbed.`)
    }
  }
  const withoutPosition = fleet.trucks.filter(t => !t.gps).length

  const historySummary = { reservedCore: history.reservedCore, renewingRecent: history.renewingRecent, other: history.other }
  return {
    settings,
    routes,
    dateOptions: decision.options,
    firstFullLiveBy: decision.firstFullLiveBy,
    cheapestDate: decision.cheapestDate,
    defaultOption: Math.max(0, decision.options.findIndex(o => o.liveBy.feasible)),
    pricing: {
      chosen: priceProgram(req.areas.length, req.model, { smartDirectional: req.smartDirectional, rateOverrides }),
      other: priceProgram(req.areas.length, OTHER[req.model], { smartDirectional: req.smartDirectional, rateOverrides }),
    },
    capacity: {
      activeTrucks: fleet.activeTrucks,
      maintenanceReserve,
      reservedLow,
      reservedHigh,
      renewingTrucks,
      renewingOn: !!req.alloyRenews,
      rows,
      history: historySummary,
    },
    fleet: { candidates: fleet.trucks.length, reserved: fleet.reserved, withoutPosition },
    warnings,
  }
}

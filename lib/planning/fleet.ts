/**
 * The planning fleet: every bookable truck, its jobs through the plan window,
 * where it is now, and which trucks are held back for other commitments.
 *
 * Reservation rules, and why each exists:
 *
 *   - Soft-hold trucks (ATT_SOFT) belong to AT&T. The holds are loaded one
 *     month at a time, but the commitment is ongoing, so the trucks on the
 *     LATEST month of soft holds on file are reserved for the whole plan — and
 *     stay reserved however long ago that month was, until a newer month is
 *     loaded. Only the latest month counts: older months are rarely expired,
 *     and the roster rotates, so taking every month would reserve trucks AT&T
 *     has already handed back.
 *
 * With soft holds not reserved, their jobs are dropped instead: a rep releasing
 * them is exactly what "yieldable" means.
 */

import { query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { loadFleetTimelines } from '@/lib/fleetTimelines'
import { ALL_TRUCKS_QUERY } from '@/lib/scheduleQuery'
import { HIDDEN_TRUCKS } from '@/lib/availabilityEngine'
import { addDays, latestSoftHoldTrucks, type PlanTruck } from './planner'

export type ReservationRules = {
  reserveSoftHolds: boolean
}

export const DEFAULT_RULES: ReservationRules = {
  reserveSoftHolds: true,
}

export type ReservedTruck = { truckNumber: string; reason: string }

export type PlanningFleet = {
  trucks: PlanTruck[]
  reserved: ReservedTruck[]
  /** Active, bookable trucks in the fleet (not archived, not hidden). */
  activeTrucks: number
}

export async function loadPlanningFleet(opts: {
  today: string
  planThrough: string
  rules: ReservationRules
  /** A booking being revised: its holds do not count as busy (lib/fleetTimelines.ts). */
  excludeHoldIds?: Set<string>
}): Promise<PlanningFleet> {
  const { today, planThrough, rules } = opts
  const [fleet, truckRows, softHolds] = await Promise.all([
    // Look back far enough to see the job a truck is on today.
    loadFleetTimelines({ hiddenTrucks: HIDDEN_TRUCKS, window: { start: addDays(today, -30), end: planThrough }, excludeHoldIds: opts.excludeHoldIds }),
    query<{ truck_number: string }[]>(ALL_TRUCKS_QUERY),
    // Every soft hold on file, any age: only the latest month is used.
    prisma.hold.findMany({
      where: { status: 'ATT_SOFT' },
      select: { truck_number: true, start_date: true },
    }),
  ])
  const softHeld = latestSoftHoldTrucks(softHolds)

  const active = truckRows.map(r => String(r.truck_number)).filter(t => t && !HIDDEN_TRUCKS.has(t))

  const reserved: ReservedTruck[] = []
  const trucks: PlanTruck[] = []
  for (const truckNumber of active) {
    const jobs = fleet.timelines.get(truckNumber) ?? []

    if (rules.reserveSoftHolds && softHeld.has(truckNumber)) {
      reserved.push({ truckNumber, reason: 'AT&T soft hold' })
      continue
    }
    const gps = fleet.gpsMap.get(truckNumber)
    trucks.push({
      truckNumber,
      jobs: rules.reserveSoftHolds ? jobs : jobs.filter(j => !j.yieldable),
      gps: gps?.latitude && gps?.longitude ? { lat: gps.latitude, lng: gps.longitude } : null,
      gpsLabel: gps ? [gps.city, gps.state].filter(Boolean).join(', ') : '',
    })
  }
  return { trucks, reserved, activeTrucks: active.length }
}

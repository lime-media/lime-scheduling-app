/**
 * The planning fleet: every bookable truck, its jobs through the plan window,
 * where it is now, and which trucks are held back for other commitments.
 *
 * Reservation rules, and why each exists:
 *
 *   - Soft-hold trucks (ATT_SOFT) belong to AT&T. The holds are loaded one
 *     month at a time, but the commitment is ongoing, so the trucks on the
 *     LATEST month of soft holds on file are reserved for the whole plan — and
 *     stay reserved after that month lapses. Only the latest month counts:
 *     older months are rarely expired, and the roster rotates, so taking every
 *     recent month would reserve trucks AT&T has already handed back.
 *   - Programs expected to renew (AT&T's Alloy Build, by default off) keep
 *     their trucks. Matched on program name UNDER the reserved client, because
 *     a program named after the product is not recognisably AT&T by name.
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
  /** Booking clients whose programs can be reserved (AT&T books as 160over90). */
  reservedClients: string[]
  /** Programs under those clients treated as renewing indefinitely. */
  renewingPrograms: string[]
}

export const DEFAULT_RULES: ReservationRules = {
  reserveSoftHolds: true,
  reservedClients: ['160over90'],
  renewingPrograms: [],
}

export type ReservedTruck = { truckNumber: string; reason: string }

export type PlanningFleet = {
  trucks: PlanTruck[]
  reserved: ReservedTruck[]
  /** Active, bookable trucks in the fleet (not archived, not hidden). */
  activeTrucks: number
}

const lower = (s: string) => s.trim().toLowerCase()

/** How far back to look for the latest month of soft holds once they lapse. */
export const SOFT_HOLD_LOOKBACK_DAYS = 90

export async function loadPlanningFleet(opts: {
  today: string
  planThrough: string
  rules: ReservationRules
}): Promise<PlanningFleet> {
  const { today, planThrough, rules } = opts
  const [fleet, truckRows, softHolds] = await Promise.all([
    // Look back far enough to see the job a truck is on today.
    loadFleetTimelines({ hiddenTrucks: HIDDEN_TRUCKS, window: { start: addDays(today, -30), end: planThrough } }),
    query<{ truck_number: string }[]>(ALL_TRUCKS_QUERY),
    prisma.hold.findMany({
      where: { status: 'ATT_SOFT', end_date: { gte: new Date(addDays(today, -SOFT_HOLD_LOOKBACK_DAYS) + 'T00:00:00Z') } },
      select: { truck_number: true, start_date: true },
    }),
  ])
  const softHeld = latestSoftHoldTrucks(softHolds)

  const active = truckRows.map(r => String(r.truck_number)).filter(t => t && !HIDDEN_TRUCKS.has(t))
  const renewing = new Set(rules.renewingPrograms.map(lower))
  const clients = new Set(rules.reservedClients.map(lower))

  const reserved: ReservedTruck[] = []
  const trucks: PlanTruck[] = []
  for (const truckNumber of active) {
    const jobs = fleet.timelines.get(truckNumber) ?? []

    if (rules.reserveSoftHolds && softHeld.has(truckNumber)) {
      reserved.push({ truckNumber, reason: 'AT&T soft hold' })
      continue
    }
    const renew = jobs.find(j =>
      j.source === 'SCHEDULE' && j.end >= today
      && renewing.has(lower(j.program ?? '')) && clients.has(lower(j.client ?? '')),
    )
    if (renew) {
      reserved.push({ truckNumber, reason: `${renew.program} renews` })
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

/**
 * Shared primitives for multi-market planning: the truck shape the routing
 * engine works on, date arithmetic, the AT&T soft-hold roster, and when a
 * truck is next free. Routing lives in order.ts, pricing in quote.ts.
 */

import type { Coords } from '@/lib/chainFeasibility'
import { findWindowClash, type TruckJob } from '@/lib/truckTimeline'

export type PlanTruck = {
  truckNumber: string
  jobs: TruckJob[]
  gps: Coords | null
  gpsLabel: string
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
// Availability
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

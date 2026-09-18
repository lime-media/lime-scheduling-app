/**
 * Flag holds whose truck no longer exists.
 *
 * Holds are keyed on `truck_number`, a string, while the LED app keys trucks on
 * `truck_uid`. Renumbering a truck in the LED app therefore silently orphans
 * every hold placed under its old number: the hold keeps blocking a truck that,
 * as far as every query in this app is concerned, does not exist.
 *
 * That is not hypothetical. Truck record 8A7D0893… was numbered 6276 in April
 * 2026, picked up an auto-generated ATT_SOFT hold for June, and was renumbered
 * to 00001257 that same month. The hold stayed behind under 6276 and sat on the
 * Reservations page for months attached to nothing.
 *
 * This does not delete anything. An orphan can mean a renumber, a hard-deleted
 * truck, or a typo in a manually placed hold, and the right resolution differs
 * for each — it needs a person. The job here is to make sure one finds out.
 *
 * Idempotency without a schema change
 * -----------------------------------
 * The cron runs hourly, so an orphan matches on every run until someone deals
 * with it. As in holdExpiryWarnings, a FLAG_ORPHAN_HOLD audit row per hold is
 * the record that it has already been reported, so the log carries the orphan
 * once rather than 24 times a day. Keyed on the hold alone, not the hold plus
 * some deadline — unlike an expiry, an orphan does not come back in a new form.
 */

import { prisma } from '@/lib/prisma'
import { query } from '@/lib/mssql'
import { activeHoldWhere } from '@/lib/holdFilters'
import { getLiveVehicleLocations } from '@/lib/samsaraService'

export const ORPHAN_ACTION = 'FLAG_ORPHAN_HOLD'

export type OrphanHoldResult = {
  holds_checked:   number
  orphans:         number
  newly_flagged:   number
  already_flagged: number
  truck_numbers:   string[]
  /** True when the fleet roster could not be built and the check was skipped. */
  skipped:         boolean
}

const EMPTY: OrphanHoldResult = {
  holds_checked: 0, orphans: 0, newly_flagged: 0,
  already_flagged: 0, truck_numbers: [], skipped: true,
}

/**
 * Compare on digits with leading zeros stripped: the same truck is written
 * '1257' in one place and '00001257' in another, and that spelling difference
 * is not what this is looking for.
 */
function fleetKey(truckNumber: string): string {
  return truckNumber.trim().replace(/^0+/, '') || truckNumber.trim()
}

export async function detectOrphanHolds(): Promise<OrphanHoldResult> {
  // Archived trucks (is_deleted = 1) count as existing. A hold on a truck ops
  // archived is a different problem with a different fix, and folding it in
  // here would bury the renumbering signal this exists to surface.
  let fleet: Set<string>
  try {
    const rows = await query<{ truck_number: string }[]>(
      `SELECT truck_number FROM dbo.trucks`
    )
    fleet = new Set(rows.map(r => fleetKey(String(r.truck_number ?? ''))))
  } catch (err) {
    console.error('[orphan-holds] truck roster query failed; skipping check:', err)
    return EMPTY
  }

  // Trucks live in Samsara but not yet in the LED app show on the grid (see the
  // Samsara-only branch in app/api/schedule/route.ts), so a hold on one is
  // legitimate. If Samsara is unreachable the roster is incomplete, and running
  // anyway would flag every one of those as an orphan — skip instead.
  try {
    const gps = await getLiveVehicleLocations()
    for (const num of gps.keys()) fleet.add(fleetKey(num))
  } catch (err) {
    console.error('[orphan-holds] Samsara unreachable; skipping check to avoid false flags:', err)
    return EMPTY
  }

  if (fleet.size === 0) {
    console.error('[orphan-holds] empty fleet roster; skipping check')
    return EMPTY
  }

  // Only holds that still reserve a truck. An EXPIRED or lapsed orphan harms
  // nothing and is just history.
  const holds = await prisma.hold.findMany({
    where:   activeHoldWhere(),
    select:  {
      id: true, truck_number: true, client_name: true, status: true,
      source: true, start_date: true, end_date: true, created_by: true,
    },
    orderBy: { created_at: 'asc' },
  })

  const orphans = holds.filter(h => !fleet.has(fleetKey(h.truck_number)))

  const result: OrphanHoldResult = {
    holds_checked:   holds.length,
    orphans:         orphans.length,
    newly_flagged:   0,
    already_flagged: 0,
    truck_numbers:   [...new Set(orphans.map(h => h.truck_number))].sort(),
    skipped:         false,
  }
  if (orphans.length === 0) return result

  const flagged = await prisma.auditLog.findMany({
    where:  { action: ORPHAN_ACTION, hold_id: { in: orphans.map(h => h.id) } },
    select: { hold_id: true },
  })
  const alreadyFlagged = new Set(flagged.map(r => r.hold_id))

  for (const h of orphans) {
    if (alreadyFlagged.has(h.id)) {
      result.already_flagged += 1
      continue
    }
    await prisma.auditLog.create({
      data: {
        action:       ORPHAN_ACTION,
        truck_number: h.truck_number,
        user_id:      h.created_by,
        hold_id:      h.id,
        details:      JSON.stringify({
          client_name: h.client_name,
          status:      h.status,
          source:      h.source,
          start_date:  h.start_date,
          end_date:    h.end_date,
          reason:      'truck_number matches no truck in dbo.trucks or Samsara',
        }),
      },
    })
    result.newly_flagged += 1
    console.warn(
      `[orphan-holds] hold ${h.id} reserves truck ${h.truck_number}, which does not exist ` +
      `(${h.client_name}, ${h.status}, ${h.start_date.toISOString().split('T')[0]} → ` +
      `${h.end_date.toISOString().split('T')[0]})`
    )
  }

  return result
}

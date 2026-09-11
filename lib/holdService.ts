import { prisma } from '@/lib/prisma'
import { activeHoldWhere } from '@/lib/holdFilters'
import { query } from '@/lib/mssql'
import { checkTruckFeasibility } from '@/lib/availabilityEngine'

export interface CreateHoldParams {
  truck_number: string
  market: string
  state: string
  client_name: string
  start_date: string // yyyy-MM-dd
  end_date: string   // yyyy-MM-dd
  status?: string
  notes?: string
  created_by: string
  origination?: 'frontend' | 'mcp'
  /**
   * Skip the chain feasibility gate. Only for paths that MIRROR a booking made
   * elsewhere (Salesforce pushes, ATT sync) — refusing those would drop a record
   * the upstream system already believes exists. Such holds are still reported
   * by the infeasible-hold audit. Never set this on a path where someone is
   * actually choosing a truck.
   */
  skipFeasibilityCheck?: boolean
}

export interface HoldConflictError {
  type: 'hold_conflict' | 'schedule_conflict' | 'feasibility_conflict'
  message: string
}

export type CreateHoldResult =
  | { success: true; hold: Awaited<ReturnType<typeof prisma.hold.create>> }
  | { success: false; error: HoldConflictError }

export async function createHold(params: CreateHoldParams): Promise<CreateHoldResult> {
  const {
    truck_number, market, state, client_name,
    start_date, end_date, status, notes,
    created_by, origination = 'frontend', skipFeasibilityCheck = false,
  } = params

  // Check for conflicts with existing holds on same truck + date range.
  // ATT_SOFT holds are soft placeholders and released holds (status EXPIRED,
  // or expires_at already passed) no longer reserve the truck — none of them
  // block regular hold creation.
  const conflictingHolds = await prisma.hold.findMany({
    where: {
      truck_number,
      ...activeHoldWhere({ excludeAttSoft: true }),
      start_date: { lte: new Date(end_date) },
      end_date:   { gte: new Date(start_date) },
    },
  })

  if (conflictingHolds.length > 0) {
    return {
      success: false,
      error: {
        type: 'hold_conflict',
        message: 'Conflict: truck already has a hold in this date range',
      },
    }
  }

  // Block hold placement if the truck already has a LED schedule in this date range
  try {
    const schedConflict = await query<{ program: string }[]>(`
      SELECT TOP 1 cp.program
      FROM dbo.program_schedule ps
      JOIN dbo.trucks          t  ON t.truck_uid          = ps.truck_uid
      JOIN dbo.client_programs cp ON cp.client_program_uid = ps.client_program_uid
      WHERE t.truck_number                   = @truck_number
        AND CAST(ps.end_time   AS DATE) >= CAST(@start_date AS DATE)
        AND CAST(ps.start_time AS DATE) <= CAST(@end_date   AS DATE)
        AND COALESCE(t.is_deleted, 0) = 0
    `, { truck_number, start_date, end_date })

    if (schedConflict.length > 0) {
      return {
        success: false,
        error: {
          type: 'schedule_conflict',
          message: `Cannot place hold — Truck ${truck_number} is already scheduled for "${schedConflict[0].program}" on these dates`,
        },
      }
    }
  } catch (err) {
    // If the schedule check fails, log but don't block hold creation
    console.error('[holdService] schedule conflict check failed:', err)
  }

  // Chain feasibility: can the truck get there, and does taking it strand a job
  // it is already committed to? Soft (ATT_SOFT) successors are overridable and
  // handled at selection time, so anything still blocking here is a hard break.
  if (!skipFeasibilityCheck) {
    try {
      const feasibility = await checkTruckFeasibility({
        truckNumber: truck_number,
        market,
        startDate: start_date,
        endDate: end_date,
      })
      if (!feasibility.ok && !feasibility.overridable) {
        return {
          success: false,
          error: {
            type: 'feasibility_conflict',
            message: `Cannot place hold — ${feasibility.detail ?? 'truck cannot serve these dates'}`,
          },
        }
      }
    } catch (err) {
      // Deliberate fail-open: a logistics lookup outage must not stop a booking.
      // Tagged so it is greppable and distinguishable from a business rejection —
      // a spike here means the check is not running, not that trucks are free.
      console.error('[holdService] FEASIBILITY_CHECK_FAILED (allowing hold):', err)
    }
  }

  const hold = await prisma.hold.create({
    data: {
      truck_number,
      market,
      state,
      client_name,
      start_date: new Date(start_date),
      end_date: new Date(end_date),
      status: status || 'HOLD',
      origination,
      notes,
      created_by,
    },
  })

  await prisma.auditLog.create({
    data: {
      action: 'CREATE_HOLD',
      truck_number,
      user_id: created_by,
      hold_id: hold.id,
      details: JSON.stringify({ client_name, market, state, start_date, end_date, status, origination }),
    },
  })

  return { success: true, hold }
}

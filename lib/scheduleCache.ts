/**
 * Schedule conflict detection.
 *
 * detectConflicts() compares all active holds against LED schedule blocks and
 * writes new conflicts to dbo.schedule_conflicts.  It is idempotent — duplicate
 * checks are skipped.  Call this after any schedule cache refresh or hold creation.
 */

import { getPool, query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { SCHEDULED_QUERY } from '@/lib/scheduleQuery'
import { sendConflictEmail } from '@/lib/emailService'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'

// ── Cache refresh ─────────────────────────────────────────────────────────────

function toDateStr(val: unknown): string {
  if (!val) return ''
  if (val instanceof Date) return val.toISOString().split('T')[0]
  const s = String(val)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  try { return new Date(s).toISOString().split('T')[0] } catch { return '' }
}

/**
 * Fetches fresh schedule + holds data and runs conflict detection.
 * Called by the cron job every 5 minutes.
 */
export async function refreshCache(): Promise<void> {
  console.log('[scheduleCache] refreshing...')

  await releaseAttSoftHolds().catch((err) =>
    console.error('[scheduleCache] ATT_SOFT release check failed:', err)
  )

  await expireHolds().catch((err) =>
    console.error('[scheduleCache] hold expiry check failed:', err)
  )

  const [schedulesRaw, holdsRaw] = await Promise.all([
    query<Record<string, unknown>[]>(SCHEDULED_QUERY),
    // ATT_SOFT holds are soft placeholders and EXPIRED holds are released —
    // exclude both from conflict detection
    prisma.hold.findMany({
      where:   { status: { notIn: ['ATT_SOFT', 'EXPIRED'] } },
      orderBy: { start_date: 'asc' },
    }),
  ])

  const schedulesAll: ConflictSchedule[] = schedulesRaw.map((r) => ({
    truck_number: String(r.truck_number ?? ''),
    program:      String(r.program      ?? ''),
    market:       String(r.market       ?? ''),
    shift_start:  toDateStr(r.shift_start),
    shift_end:    toDateStr(r.shift_end),
  }))

  // Deduplicate by truck_number + program + shift_start before conflict detection.
  // The source query can return multiple rows per program/date (one per market row).
  const schedules = schedulesAll.filter((s, index, self) =>
    index === self.findIndex((t) =>
      t.truck_number === s.truck_number &&
      t.program      === s.program &&
      t.shift_start  === s.shift_start
    )
  )

  const holds: ConflictHold[] = holdsRaw.map((h) => ({
    id:                  h.id,
    truck_number:        h.truck_number,
    client_name:         h.client_name,
    market:              h.market,
    source:              h.source,
    start_date:          h.start_date.toISOString().split('T')[0],
    end_date:            h.end_date.toISOString().split('T')[0],
    sfdc_opportunity_id: h.sfdc_opportunity_id,
  }))

  await detectConflicts(schedules, holds)
  console.log('[scheduleCache] refresh complete')
}

// ── ATT soft-hold release ───────────────────────────────────────────────────────

function isAttProgram(program: unknown): boolean {
  return String(program ?? '').trim().toUpperCase().startsWith('ATT')
}

async function releaseHold(hold: { id: string; truck_number: string; created_by: string }, reason: string, scheduledProgram: string): Promise<void> {
  await prisma.auditLog.create({
    data: {
      action:       'DELETE_HOLD',
      truck_number: hold.truck_number,
      user_id:      hold.created_by,
      hold_id:      hold.id,
      details:      JSON.stringify({ reason, scheduled_program: scheduledProgram }),
    },
  })
  await prisma.hold.delete({ where: { id: hold.id } })
  console.log(`[att-sync] released ATT_SOFT hold: truck ${hold.truck_number} — ${reason} ("${scheduledProgram}")`)
}

/**
 * Deletes an ATT_SOFT hold in either of two cases:
 *  1. A real shift now overlaps the hold's date range and it isn't ATT — the
 *     hold's premise (truck idle / ATT-only) no longer holds.
 *  2. The truck's shift immediately before the hold started was never
 *     actually ATT — re-validates att-sync's own creation criteria, so a hold
 *     created from a stale lookback (e.g. skipping a same-month shift dated
 *     after the sync's run time) self-heals instead of lingering forever.
 * An ATT shift in either check leaves the hold in place.
 */
export async function releaseAttSoftHolds(): Promise<number> {
  const softHolds = await prisma.hold.findMany({ where: { status: 'ATT_SOFT' } })
  if (softHolds.length === 0) return 0

  let released = 0

  for (const hold of softHolds) {
    const startStr = toDateStr(hold.start_date)
    const endStr   = toDateStr(hold.end_date)

    // ps.start_time only — ps.end_time bleeds into the next calendar day for
    // overnight shifts, so it's unsafe for date-range filtering.
    const overlapping = await query<{ program: string }[]>(
      `
      SELECT cp.program
      FROM dbo.program_schedule ps
      JOIN dbo.trucks          t  ON t.truck_uid          = ps.truck_uid
      JOIN dbo.client_programs cp ON cp.client_program_uid = ps.client_program_uid
      WHERE t.truck_number = @truckNumber
        AND CAST(ps.start_time AS DATE) BETWEEN @startDate AND @endDate
      `,
      { truckNumber: hold.truck_number, startDate: startStr, endDate: endStr }
    )

    const nonAttOverlap = overlapping.find((r) => !isAttProgram(r.program))
    if (nonAttOverlap) {
      await releaseHold(hold, 'att_soft_superseded_by_non_att_shift', nonAttOverlap.program)
      released++
      continue
    }

    const priorShift = await query<{ program: string }[]>(
      `
      SELECT TOP 1 cp.program
      FROM dbo.program_schedule ps
      JOIN dbo.trucks          t  ON t.truck_uid          = ps.truck_uid
      JOIN dbo.client_programs cp ON cp.client_program_uid = ps.client_program_uid
      WHERE t.truck_number = @truckNumber
        AND CAST(ps.start_time AS DATE) < @startDate
      ORDER BY ps.start_time DESC
      `,
      { truckNumber: hold.truck_number, startDate: startStr }
    )

    if (priorShift.length > 0 && !isAttProgram(priorShift[0].program)) {
      await releaseHold(hold, 'att_soft_premise_invalid_prior_shift_not_att', priorShift[0].program)
      released++
    }
  }

  return released
}

// ── SFDC hold expiry ────────────────────────────────────────────────────────────

/**
 * Releases (from scheduling purposes) any Salesforce-sourced hold whose
 * `sfdc_hold_exp` date has passed — the day AFTER that date, the hold no
 * longer reserves the truck anywhere in the app (grid, map, AI context,
 * partner API), but unlike a manual Release the row is kept, just flipped to
 * status EXPIRED, so it stays visible on the Holds page for ops to review.
 *
 * Only status HOLD is eligible — a hold someone has already upgraded to
 * COMMITTED represents a real deal, not a stale tentative one, so it's left
 * alone even past its original hold-expiration date.
 *
 * If Salesforce later re-pushes the same Opportunity with a later hold-exp
 * date, the webhook resets status back to HOLD (see
 * app/api/integrations/salesforce/hold/route.ts) — this isn't a dead end.
 */
/**
 * Unified hold expiration — expires any hold whose `expires_at` has passed.
 * Covers both Salesforce holds (expires_at backfilled from sfdc_hold_exp)
 * and client holds (expires_at from 72h SLA). Holds without expires_at
 * (internal/ATT) are never matched — they don't expire automatically.
 */
export async function expireHolds(): Promise<number> {
  const now = new Date()

  const stale = await prisma.hold.findMany({
    where: {
      status:     { in: ['HOLD', 'EXTENSION_REQUESTED'] },
      expires_at: { lt: now },
    },
  })
  if (stale.length === 0) return 0

  for (const hold of stale) {
    await prisma.auditLog.create({
      data: {
        action:       'EXPIRE_HOLD',
        truck_number: hold.truck_number,
        user_id:      hold.created_by,
        hold_id:      hold.id,
        details:      JSON.stringify({
          reason:              'expires_at_passed',
          source:              hold.source,
          sfdc_opportunity_id: hold.sfdc_opportunity_id,
          expires_at:          hold.expires_at,
        }),
      },
    })
    await prisma.hold.update({ where: { id: hold.id }, data: { status: 'EXPIRED' } })
    console.log(`[hold-expiry] expired hold: truck ${hold.truck_number} | "${hold.client_name}" (${hold.source}) — expires_at passed`)
  }

  return stale.length
}

// DEPRECATED — kept as re-exports for any callers not yet updated
export const expireSfdcHolds = expireHolds
export const expireHoldRequests = expireHolds

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConflictHold {
  id:                  string
  truck_number:        string
  client_name:         string
  market:              string
  source:              string
  start_date:          string  // YYYY-MM-DD
  end_date:            string  // YYYY-MM-DD
  sfdc_opportunity_id?: string | null
}

export interface ConflictSchedule {
  truck_number: string
  program:      string
  market:       string
  shift_start:  string  // YYYY-MM-DD
  shift_end:    string  // YYYY-MM-DD
}

// ── Conflict detection ────────────────────────────────────────────────────────

export async function detectConflicts(
  schedules: ConflictSchedule[],
  holds:     ConflictHold[]
): Promise<void> {
  if (holds.length === 0 || schedules.length === 0) return

  const pool = await getPool()

  // Only fetched if a Salesforce-sourced hold actually overlaps a schedule —
  // needed to attribute the auto-release audit log entry.
  let sfdcServiceUserId: string | null | undefined

  for (const hold of holds) {
    // Find schedule blocks that overlap this hold's date range on the same truck
    const overlapping = schedules.filter(
      (s) =>
        s.truck_number === hold.truck_number &&
        s.shift_start  <= hold.end_date &&
        s.shift_end    >= hold.start_date
    )

    if (hold.source === 'SALESFORCE' && hold.sfdc_opportunity_id && overlapping.length > 0) {
      // A real LED shift now covers this Salesforce-sourced hold — the deal has
      // converted to a firm booking, so release the tentative hold instead of
      // flagging it as a conflict for manual review.
      if (sfdcServiceUserId === undefined) {
        const serviceUser = await prisma.user.findUnique({ where: { email: SFDC_SERVICE_USER_EMAIL } })
        sfdcServiceUserId = serviceUser?.id ?? null
      }

      if (sfdcServiceUserId) {
        await prisma.auditLog.create({
          data: {
            action:       'DELETE_HOLD',
            truck_number: hold.truck_number,
            user_id:      sfdcServiceUserId,
            hold_id:      hold.id,
            details:      JSON.stringify({
              reason:              'sfdc_converted_to_booked',
              sfdc_opportunity_id: hold.sfdc_opportunity_id,
              scheduled_program:   overlapping[0].program,
            }),
          },
        })
        await prisma.hold.delete({ where: { id: hold.id } })

        console.log(
          `[conflicts] auto-released Salesforce hold: truck ${hold.truck_number} | "${hold.client_name}" — now covered by schedule "${overlapping[0].program}"`
        )
        continue
      }
      // Service user missing — fall through to normal conflict flagging below
      // rather than silently losing track of the overlap.
    }

    for (const sched of overlapping) {
      // Compute overlap window first — the duplicate check uses these values
      const conflictStart = hold.start_date > sched.shift_start ? hold.start_date : sched.shift_start
      const conflictEnd   = hold.end_date   < sched.shift_end   ? hold.end_date   : sched.shift_end

      // Skip if a conflict for this truck+hold+date window is already recorded.
      // Keying on dates (not program name) handles cases where the same schedule
      // block appears under slightly different program strings across runs.
      const existing = await pool
        .request()
        .input('holdId',        hold.id)
        .input('truckNumber',   hold.truck_number)
        .input('conflictStart', conflictStart)
        .input('conflictEnd',   conflictEnd)
        .query(`
          SELECT id FROM dbo.schedule_conflicts
          WHERE hold_id        = @holdId
            AND truck_number   = @truckNumber
            AND conflict_start = @conflictStart
            AND conflict_end   = @conflictEnd
            AND status         = 'ACTIVE'
        `)

      if (existing.recordset.length > 0) continue

      await pool
        .request()
        .input('holdId',           hold.id)
        .input('truckNumber',      hold.truck_number)
        .input('conflictStart',    conflictStart)
        .input('conflictEnd',      conflictEnd)
        .input('holdClient',       hold.client_name)
        .input('holdMarket',       hold.market)
        .input('scheduledProgram', sched.program)
        .query(`
          INSERT INTO dbo.schedule_conflicts
            (id, hold_id, truck_number, conflict_start, conflict_end,
             hold_client, hold_market, scheduled_program)
          VALUES
            (NEWID(), @holdId, @truckNumber, @conflictStart, @conflictEnd,
             @holdClient, @holdMarket, @scheduledProgram)
        `)

      console.log(
        `[conflicts] new conflict: truck ${hold.truck_number} | hold "${hold.client_name}" ↔ schedule "${sched.program}" (${conflictStart}–${conflictEnd})`
      )

      // Fire-and-forget email — don't let email failure break the detection loop
      sendConflictEmail({
        truck_number:      hold.truck_number,
        hold_client:       hold.client_name,
        hold_market:       hold.market,
        scheduled_program: sched.program,
        conflict_start:    conflictStart,
        conflict_end:      conflictEnd,
        hold_id:           hold.id,
      }).catch((err) => console.error('[conflicts] email failed:', err))
    }
  }
}

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

  const [schedulesRaw, holdsRaw] = await Promise.all([
    query<Record<string, unknown>[]>(SCHEDULED_QUERY),
    prisma.hold.findMany({ orderBy: { start_date: 'asc' } }),
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
    id:           h.id,
    truck_number: h.truck_number,
    client_name:  h.client_name,
    market:       h.market,
    start_date:   h.start_date.toISOString().split('T')[0],
    end_date:     h.end_date.toISOString().split('T')[0],
  }))

  await detectConflicts(schedules, holds)
  console.log('[scheduleCache] refresh complete')
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConflictHold {
  id:           string
  truck_number: string
  client_name:  string
  market:       string
  start_date:   string  // YYYY-MM-DD
  end_date:     string  // YYYY-MM-DD
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

  for (const hold of holds) {
    // Find schedule blocks that overlap this hold's date range on the same truck
    const overlapping = schedules.filter(
      (s) =>
        s.truck_number === hold.truck_number &&
        s.shift_start  <= hold.end_date &&
        s.shift_end    >= hold.start_date
    )

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

/**
 * Schedule conflict detection.
 *
 * detectConflicts() compares all active holds against LED schedule blocks and
 * writes new conflicts to dbo.schedule_conflicts.  It is idempotent — duplicate
 * checks are skipped.  Call this after any schedule cache refresh or hold creation.
 */

import { getPool, query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere } from '@/lib/holdFilters'
import { reconcileSfdcOpportunities, closeOpportunityAsLost } from '@/lib/sfdcOpportunityReconcile'
import { warnExpiringHolds } from '@/lib/holdExpiryWarnings'
import { detectOrphanHolds } from '@/lib/orphanHolds'
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

export interface RefreshSummary {
  att_soft_released:     number
  sfdc_committed:        number
  sfdc_released:         number
  sfdc_checked:          number
  holds_expired:              number
  opportunities_closed:       number
  opportunities_would_close:  number
  expiry_warnings_sent:       number
  expiry_warning_recipients:  number
  conflicts_auto_resolved:    number
  orphan_holds:               number
  orphan_hold_trucks:         string[]
}

/**
 * Releases stale ATT_SOFT holds, settles holds whose Salesforce Opportunity has
 * closed, expires holds past their `expires_at`, then refreshes schedule data
 * and runs conflict detection.
 *
 * Driven by Vercel Cron via GET /api/cron (see vercel.json). It used to run on
 * an in-process node-cron timer started from app/layout.tsx, which silently
 * never fired in production: on serverless the instance is frozen once the
 * response is sent, so an hourly timer never reaches its next tick and holds
 * were left past their expiry indefinitely.
 *
 * Returns what it changed so the cron endpoint can report it.
 */
export async function refreshCache(): Promise<RefreshSummary> {
  console.log('[scheduleCache] refreshing...')

  const att_soft_released = await releaseAttSoftHolds().catch((err) => {
    console.error('[scheduleCache] ATT_SOFT release check failed:', err)
    return 0
  })

  // Before expiry: a Closed Won Opportunity sitting past its Hold Exp should be
  // committed, not expired out from under itself.
  const sfdc = await reconcileSfdcOpportunities().catch((err) => {
    console.error('[scheduleCache] SFDC opportunity reconcile failed:', err)
    return { checked: 0, committed: 0, released: 0 }
  })

  const expiry = await expireHolds().catch((err) => {
    console.error('[scheduleCache] hold expiry check failed:', err)
    return { expired: 0, opportunities_closed: 0, opportunities_would_close: 0 }
  })

  // After expiry, so anything that just lapsed is not warned about on its way
  // out. Never allowed to fail the sweep — a warning is worth less than the
  // expiry and reconcile work that runs alongside it.
  const warnings = await warnExpiringHolds().catch((err) => {
    console.error('[scheduleCache] expiry warnings failed:', err)
    return { candidates: 0, warned: 0, recipients: 0, skipped_already_warned: 0, skipped_no_email: 0 }
  })

  // Reporting only — nothing downstream depends on it, and an orphan is worth
  // less than the expiry and conflict work running alongside it.
  const orphans = await detectOrphanHolds().catch((err) => {
    console.error('[scheduleCache] orphan hold check failed:', err)
    return { holds_checked: 0, orphans: 0, newly_flagged: 0, already_flagged: 0, truck_numbers: [] as string[], skipped: true }
  })

  const [schedulesRaw, holdsRaw] = await Promise.all([
    query<Record<string, unknown>[]>(SCHEDULED_QUERY),
    // ATT_SOFT holds are soft placeholders, and a hold is released once it is
    // status EXPIRED or past its expires_at — exclude all of them from
    // conflict detection
    prisma.hold.findMany({
      where:   activeHoldWhere({ excludeAttSoft: true }),
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

  // Before detection: a conflict whose window merely shifted is closed here and re-raised
  // against its new dates in the same pass.
  const reconciled = await reconcileConflicts(schedules, holds).catch((err) => {
    console.error('[scheduleCache] conflict reconcile failed:', err)
    return { resolved: 0 }
  })

  await detectConflicts(schedules, holds)
  console.log(
    `[scheduleCache] refresh complete — ${expiry.expired} hold(s) expired ` +
    `(${expiry.opportunities_closed} opportunit${expiry.opportunities_closed === 1 ? 'y' : 'ies'} closed lost, ` +
    `${expiry.opportunities_would_close} would close in dry run), ` +
    `${att_soft_released} ATT_SOFT hold(s) released, ` +
    `${sfdc.committed} committed / ${sfdc.released} released from ${sfdc.checked} SFDC opportunit${sfdc.checked === 1 ? 'y' : 'ies'}, ` +
    `${warnings.warned} expiry warning(s) to ${warnings.recipients} user(s), ` +
    `${reconciled.resolved} conflict(s) auto-resolved` +
    (warnings.skipped_no_email > 0 ? ` (${warnings.skipped_no_email} unwarned — no email)` : '') +
    (orphans.orphans > 0 ? `, ${orphans.orphans} orphan hold(s) on ${orphans.truck_numbers.join(', ')}` : '')
  )

  return {
    att_soft_released,
    sfdc_committed:       sfdc.committed,
    sfdc_released:        sfdc.released,
    sfdc_checked:         sfdc.checked,
    holds_expired:             expiry.expired,
    opportunities_closed:      expiry.opportunities_closed,
    opportunities_would_close: expiry.opportunities_would_close,
    expiry_warnings_sent:      warnings.warned,
    expiry_warning_recipients: warnings.recipients,
    conflicts_auto_resolved:   reconciled.resolved,
    orphan_holds:              orphans.orphans,
    orphan_hold_trucks:        orphans.truck_numbers,
  }
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
export async function expireHolds(): Promise<{
  expired: number
  opportunities_closed: number
  opportunities_would_close: number
}> {
  const now = new Date()

  const stale = await prisma.hold.findMany({
    where: {
      status:     { in: ['HOLD', 'EXTENSION_REQUESTED'] },
      expires_at: { lt: now },
    },
  })
  if (stale.length === 0) return { expired: 0, opportunities_closed: 0, opportunities_would_close: 0 }

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

  // Now that every stale hold is marked EXPIRED, settle the Salesforce side.
  // Deduplicated because one Opportunity commonly covers several trucks, and
  // deferred until after the loop so the "any active holds left?" check inside
  // closeOpportunityAsLost() sees the finished state rather than a partial one.
  //
  // Restricted to holds Salesforce itself put an expiry on. Client-portal holds
  // also carry an sfdc_opportunity_id — the app creates a WARM Opportunity for
  // them — so without this guard, ops simply not reviewing a portal booking
  // within the 72h internal SLA would move a live deal to Closed Lost - Declined.
  // The customer didn't decline; we didn't answer. Requiring sfdc_hold_exp also
  // excludes SFDC pushes that omitted Hold Exp and got the 72h fallback, so a rep
  // leaving an optional field blank can't lose their own deal.
  const touchedOpportunities = Array.from(
    new Set(
      stale
        .filter((h) => h.source === 'SALESFORCE' && h.sfdc_hold_exp !== null)
        .map((h) => h.sfdc_opportunity_id)
        .filter((id): id is string => Boolean(id))
    )
  )

  let opportunities_closed = 0
  let opportunities_would_close = 0
  for (const opportunityId of touchedOpportunities) {
    const outcome = await closeOpportunityAsLost(opportunityId)
    if (outcome === 'closed') opportunities_closed++
    else if (outcome === 'would_close') opportunities_would_close++
  }

  return { expired: stale.length, opportunities_closed, opportunities_would_close }
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

/** One (hold × schedule block) overlap, keyed the way dbo.schedule_conflicts rows are. */
export interface DetectedConflict {
  key:           string
  hold:          ConflictHold
  program:       string
  conflictStart: string  // YYYY-MM-DD
  conflictEnd:   string  // YYYY-MM-DD
}

/**
 * Identity of a conflict: which hold, on which truck, over which window. Deliberately not
 * the program name — the same schedule block comes back under slightly different program
 * strings across runs, which would make an unchanged conflict look new every hour.
 */
function conflictKey(holdId: string, truckNumber: string, start: string, end: string): string {
  return `${holdId}|${truckNumber}|${start}|${end}`
}

/**
 * Every overlap present in the CURRENT data — the single definition of "this conflict is
 * real", shared by the two passes below so they can never drift apart. detectConflicts()
 * inserts what is here and missing from the table; reconcileConflicts() resolves what is in
 * the table and missing from here.
 *
 * Pure: no database, no clock. Covered by tests/conflicts.test.ts.
 */
export function findConflicts(
  schedules: ConflictSchedule[],
  holds:     ConflictHold[]
): DetectedConflict[] {
  const found: DetectedConflict[] = []

  for (const hold of holds) {
    const overlapping = schedules.filter(
      (s) =>
        s.truck_number === hold.truck_number &&
        s.shift_start  <= hold.end_date &&
        s.shift_end    >= hold.start_date
    )

    for (const sched of overlapping) {
      const conflictStart = hold.start_date > sched.shift_start ? hold.start_date : sched.shift_start
      const conflictEnd   = hold.end_date   < sched.shift_end   ? hold.end_date   : sched.shift_end

      found.push({
        key:           conflictKey(hold.id, hold.truck_number, conflictStart, conflictEnd),
        hold,
        program:       sched.program,
        conflictStart,
        conflictEnd,
      })
    }
  }

  return found
}

/**
 * Closes out ACTIVE conflicts that reality has already settled — the hold was moved to
 * another truck, re-dated, expired or deleted, or the LED program itself moved or was
 * cancelled upstream.
 *
 * Detection alone only ever inserted, so every conflict ever raised stayed ACTIVE until a
 * human clicked Resolve. A swapped truck left a row citing a truck the reservation no longer
 * used, and the Conflicts badge counted it forever — which is what erodes trust in the ones
 * that are real.
 *
 * Resolved rows are written with `resolved_by = NULL`, distinguishing an automatic
 * resolution from a person's judgement call (the column is nullable for exactly this).
 *
 * Runs before detectConflicts() so a conflict whose window merely shifted is closed and
 * re-raised against its new dates in the same sweep.
 */
export async function reconcileConflicts(
  schedules: ConflictSchedule[],
  holds:     ConflictHold[]
): Promise<{ resolved: number }> {
  // An empty schedule set means the upstream LED query returned nothing. That is far more
  // likely to be an outage than every program in the fleet being cancelled at once, and
  // acting on it would auto-resolve the entire board. Detection sits out the same case.
  if (schedules.length === 0) return { resolved: 0 }

  const pool = await getPool()

  const live = new Set(findConflicts(schedules, holds).map((c) => c.key))

  const active = await pool.request().query(`
    SELECT
      id, hold_id, truck_number,
      CONVERT(varchar(10), conflict_start, 120) AS conflict_start,
      CONVERT(varchar(10), conflict_end,   120) AS conflict_end
    FROM dbo.schedule_conflicts
    WHERE status = 'ACTIVE'
  `)

  let resolved = 0

  for (const row of active.recordset as {
    id: string; hold_id: string; truck_number: string; conflict_start: string; conflict_end: string
  }[]) {
    if (live.has(conflictKey(row.hold_id, row.truck_number, row.conflict_start, row.conflict_end))) continue

    // Guarded on status so a human resolving the same row mid-sweep is not overwritten.
    await pool
      .request()
      .input('id', row.id)
      .query(`
        UPDATE dbo.schedule_conflicts
        SET status = 'RESOLVED', resolved_at = GETUTCDATE(), resolved_by = NULL
        WHERE id = @id AND status = 'ACTIVE'
      `)

    resolved++
    console.log(
      `[conflicts] auto-resolved: truck ${row.truck_number} | hold ${row.hold_id} ` +
      `(${row.conflict_start}–${row.conflict_end}) — overlap no longer present`
    )
  }

  return { resolved }
}

export async function detectConflicts(
  schedules: ConflictSchedule[],
  holds:     ConflictHold[]
): Promise<void> {
  if (holds.length === 0 || schedules.length === 0) return

  const pool = await getPool()

  for (const conflict of findConflicts(schedules, holds)) {
    const { hold, program, conflictStart, conflictEnd } = conflict

    // Skip if this truck+hold+date window is already recorded.
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
      .input('scheduledProgram', program)
      .query(`
        INSERT INTO dbo.schedule_conflicts
          (id, hold_id, truck_number, conflict_start, conflict_end,
           hold_client, hold_market, scheduled_program)
        VALUES
          (NEWID(), @holdId, @truckNumber, @conflictStart, @conflictEnd,
           @holdClient, @holdMarket, @scheduledProgram)
      `)

    console.log(
      `[conflicts] new conflict: truck ${hold.truck_number} | hold "${hold.client_name}" ↔ schedule "${program}" (${conflictStart}–${conflictEnd})`
    )

    // Fire-and-forget email — don't let email failure break the detection loop
    sendConflictEmail({
      truck_number:      hold.truck_number,
      hold_client:       hold.client_name,
      hold_market:       hold.market,
      scheduled_program: program,
      conflict_start:    conflictStart,
      conflict_end:      conflictEnd,
      hold_id:           hold.id,
    }).catch((err) => console.error('[conflicts] email failed:', err))
  }
}

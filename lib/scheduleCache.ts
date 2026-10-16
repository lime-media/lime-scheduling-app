/**
 * Schedule conflict detection.
 *
 * detectConflicts() compares all active holds against LED schedule blocks and
 * writes new conflicts to dbo.schedule_conflicts.  It is idempotent — duplicate
 * checks are skipped.  Call this after any schedule cache refresh or hold creation.
 */

import { expiryClosesOpportunity } from '@/lib/sfdcIntegration'
import { getPool, query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere } from '@/lib/holdFilters'
import { reconcileSfdcOpportunities, closeOpportunityAsLost } from '@/lib/sfdcOpportunityReconcile'
import { warnExpiringHolds } from '@/lib/holdExpiryWarnings'
import { SCHEDULED_QUERY } from '@/lib/scheduleQuery'
import { sendConflictEmail } from '@/lib/emailService'
import { syncAttSoftHolds } from '@/lib/attSoftHolds'
import { freeRanges } from '@/lib/ranges'

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
  att_soft_created:      number
  att_soft_warnings:     string[]
  sfdc_committed:        number
  sfdc_released:         number
  sfdc_checked:          number
  holds_expired:              number
  opportunities_closed:       number
  opportunities_would_close:  number
  expiry_warnings_sent:       number
  expiry_warning_recipients:  number
  conflicts_auto_resolved:    number
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

  // AT&T soft holds: release prior months, duplicates and stale ones, and keep
  // the current month plus the next two filled (lib/attSoftHolds.ts).
  const att = await syncAttSoftHolds().catch((err) => {
    console.error('[scheduleCache] ATT_SOFT sync failed:', err)
    return null
  })
  const att_soft_released = att ? att.releasedPriorMonths + att.releasedDuplicates + att.releasedPremise : 0
  const att_soft_created = att?.created ?? 0
  const att_soft_warnings = att ? att.warnings : ['AT&T soft-hold sync failed; see the log']

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
    return { resolved: 0, resolvedIds: [] as string[] }
  })

  await detectConflicts(schedules, holds, new Set(reconciled.resolvedIds))
  console.log(
    `[scheduleCache] refresh complete — ${expiry.expired} hold(s) expired ` +
    `(${expiry.opportunities_closed} opportunit${expiry.opportunities_closed === 1 ? 'y' : 'ies'} closed lost, ` +
    `${expiry.opportunities_would_close} would close in dry run), ` +
    `${att_soft_released} ATT_SOFT hold(s) released, ` +
    `${sfdc.committed} committed / ${sfdc.released} released from ${sfdc.checked} SFDC opportunit${sfdc.checked === 1 ? 'y' : 'ies'}, ` +
    `${warnings.warned} expiry warning(s) to ${warnings.recipients} user(s), ` +
    `${reconciled.resolved} conflict(s) auto-resolved` +
    (warnings.skipped_no_email > 0 ? ` (${warnings.skipped_no_email} unwarned — no email)` : '')
  )

  return {
    att_soft_released,
    att_soft_created,
    att_soft_warnings,
    sfdc_committed:       sfdc.committed,
    sfdc_released:        sfdc.released,
    sfdc_checked:         sfdc.checked,
    holds_expired:             expiry.expired,
    opportunities_closed:      expiry.opportunities_closed,
    opportunities_would_close: expiry.opportunities_would_close,
    expiry_warnings_sent:      warnings.warned,
    expiry_warning_recipients: warnings.recipients,
    conflicts_auto_resolved:   reconciled.resolved,
  }
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
  // Which expiries close their Opportunity: see expiryClosesOpportunity().
  //
  // A DECIDED POLICY (product owner, 2026-10-02), not a refactor: app-created
  // holds close their Opportunity too — internal quotes, multi-market AND
  // client-portal bookings. The known cost: a portal booking that lapses only
  // because ops did not review it within the 72h SLA is closed as "Closed Lost
  // - Declined" although the customer did not decline, and that flows into
  // pipeline reporting. Accepted so an expired reservation never leaves a live-
  // looking deal behind. Salesforce pushes without a Hold Exp and quote-only
  // logs are still never closed. To stop the outward writes, SFDC_AUTOCLOSE=off.
  const touchedOpportunities = Array.from(
    new Set(
      stale
        .filter(expiryClosesOpportunity)
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
 * Identity of a conflict: which hold, on which truck, against which program, over which
 * window. The program is part of it: a reservation clashing with two programs is two
 * problems, and dismissing one must not hide the other. Compared trimmed, case- and
 * space-insensitive, so a cosmetic difference in the LED program name cannot split one
 * conflict into two (none has been seen in production; this keeps it that way).
 */
export const programKey = (program: string) => program.trim().toLowerCase().replace(/\s+/g, ' ')

function conflictKey(holdId: string, truckNumber: string, program: string, start: string, end: string): string {
  return `${holdId}|${truckNumber}|${programKey(program)}|${start}|${end}`
}

const nextDay = (d: string) => new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10)

/**
 * The LED schedule as blocks: consecutive days of one program on one truck
 * merged into a single range. SCHEDULED_QUERY returns a row per scheduled
 * day, so without this a reservation over a month of a program raised thirty
 * one-day conflicts (thirty rows on the Conflicts page, thirty emails) for
 * what is one problem. A gap of a day or more starts a new block. Pure.
 */
export function mergeScheduleBlocks(schedules: ConflictSchedule[]): ConflictSchedule[] {
  const sorted = [...schedules].sort((a, b) =>
    a.truck_number.localeCompare(b.truck_number) || a.program.localeCompare(b.program) || a.shift_start.localeCompare(b.shift_start))
  const out: ConflictSchedule[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && last.truck_number === s.truck_number && last.program === s.program && s.shift_start <= nextDay(last.shift_end)) {
      if (s.shift_end > last.shift_end) last.shift_end = s.shift_end
    } else {
      out.push({ ...s })
    }
  }
  return out
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
  const blocks = mergeScheduleBlocks(schedules)

  for (const hold of holds) {
    const overlapping = blocks.filter(
      (s) =>
        s.truck_number === hold.truck_number &&
        s.shift_start  <= hold.end_date &&
        s.shift_end    >= hold.start_date
    )

    for (const sched of overlapping) {
      const conflictStart = hold.start_date > sched.shift_start ? hold.start_date : sched.shift_start
      const conflictEnd   = hold.end_date   < sched.shift_end   ? hold.end_date   : sched.shift_end

      found.push({
        key:           conflictKey(hold.id, hold.truck_number, sched.program, conflictStart, conflictEnd),
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
): Promise<{ resolved: number; resolvedIds: string[] }> {
  // An empty schedule set means the upstream LED query returned nothing. That is far more
  // likely to be an outage than every program in the fleet being cancelled at once, and
  // acting on it would auto-resolve the entire board. Detection sits out the same case.
  if (schedules.length === 0) return { resolved: 0, resolvedIds: [] }

  const pool = await getPool()

  const live = new Set(findConflicts(schedules, holds).map((c) => c.key))

  const active = await pool.request().query(`
    SELECT
      id, hold_id, truck_number, scheduled_program,
      CONVERT(varchar(10), conflict_start, 120) AS conflict_start,
      CONVERT(varchar(10), conflict_end,   120) AS conflict_end
    FROM dbo.schedule_conflicts
    WHERE status = 'ACTIVE'
  `)

  let resolved = 0
  const resolvedIds: string[] = []

  for (const row of active.recordset as {
    id: string; hold_id: string; truck_number: string; scheduled_program: string | null; conflict_start: string; conflict_end: string
  }[]) {
    if (live.has(conflictKey(row.hold_id, row.truck_number, row.scheduled_program ?? '', row.conflict_start, row.conflict_end))) continue

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
    resolvedIds.push(row.id)
    console.log(
      `[conflicts] auto-resolved: truck ${row.truck_number} | hold ${row.hold_id} ` +
      `(${row.conflict_start}–${row.conflict_end}) — overlap no longer present`
    )
  }

  return { resolved, resolvedIds }
}

/**
 * What earlier rows say about a newly found conflict over [start, end], for
 * the same reservation, truck and program:
 * - 'dismissed': people dismissed every one of these days ("keep both, stop
 *   flagging"), so it is not raised again.
 * - 'reported': it is already being shown — an ACTIVE row overlaps, or one
 *   this sweep just closed (the conflict grew or shifted, or is one-day rows
 *   becoming a range). Recorded, not emailed again.
 * - 'new': record and email. Includes a conflict that went away (closed by
 *   an earlier sweep) and has come back: email is the only push, so a
 *   recurrence is news.
 * `justResolved`: ids reconcileConflicts() closed in this same sweep. Pure.
 */
export function priorDecision(
  start: string,
  end: string,
  prior: { id: string; conflict_start: string; conflict_end: string; status: string; resolved_by: string | null }[],
  justResolved: ReadonlySet<string> = new Set(),
): 'dismissed' | 'reported' | 'new' {
  const over = prior.filter(p => p.conflict_start <= end && p.conflict_end >= start)
  const byPerson = over
    .filter(p => p.status === 'RESOLVED' && p.resolved_by)
    .map(p => ({ start: p.conflict_start, end: p.conflict_end }))
  if (byPerson.length && freeRanges(start, end, byPerson).length === 0) return 'dismissed'
  return over.some(p => p.status === 'ACTIVE' || justResolved.has(p.id)) ? 'reported' : 'new'
}

export async function detectConflicts(
  schedules: ConflictSchedule[],
  holds:     ConflictHold[],
  /** Rows reconcileConflicts() closed in this sweep (see priorDecision). */
  justResolved: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (holds.length === 0 || schedules.length === 0) return

  const pool = await getPool()

  for (const conflict of findConflicts(schedules, holds)) {
    const { hold, program, conflictStart, conflictEnd } = conflict

    // What was recorded before for this reservation, truck and program: a
    // person dismissing these dates, or the conflict already being shown.
    const prior = (await pool
      .request()
      .input('holdId',      hold.id)
      .input('truckNumber', hold.truck_number)
      .input('from',        conflictStart)
      .input('to',          conflictEnd)
      .query(`
        SELECT id, scheduled_program,
               CONVERT(varchar(10), conflict_start, 120) AS conflict_start,
               CONVERT(varchar(10), conflict_end,   120) AS conflict_end,
               status, resolved_by
        FROM dbo.schedule_conflicts
        WHERE hold_id = @holdId AND truck_number = @truckNumber
          AND conflict_start <= @to AND conflict_end >= @from
      `)).recordset.filter((p: { scheduled_program: string | null }) => programKey(p.scheduled_program ?? '') === programKey(program))

    // Already recorded exactly: nothing to do.
    if (prior.some((p: { status: string; conflict_start: string; conflict_end: string }) =>
      p.status === 'ACTIVE' && p.conflict_start === conflictStart && p.conflict_end === conflictEnd)) continue

    const decision = priorDecision(conflictStart, conflictEnd, prior, justResolved)
    if (decision === 'dismissed') continue

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

    // Already being shown: recorded, but no second email.
    if (decision === 'reported') continue

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

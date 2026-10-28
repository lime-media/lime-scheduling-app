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
import { syncOpportunityLedWindow } from '@/lib/sfdcBooking'
import { warnExpiringHolds } from '@/lib/holdExpiryWarnings'
import { SCHEDULED_QUERY, SCHEDULED_WINDOW } from '@/lib/scheduleQuery'
import { sendConflictEmail } from '@/lib/emailService'
import { syncAttSoftHolds } from '@/lib/attSoftHolds'
import { freeRanges } from '@/lib/ranges'
import { isOwnLedProgram, jobKey, linkedJob } from '@/lib/jobNumber'
import { followLedTrucks, syncFollowedOpportunities } from '@/lib/ledTruckFollow'
import { daysSold } from '@/lib/ledJobs'
import { centralDate } from '@/lib/dateOnly'
import { recordAmountChanges, recordExecuted, recordPrestart, recordSwap, sharedOriginMeasurer } from '@/lib/transportMetricsRecord'

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
  sfdc_uncommitted:      number
  sfdc_checked:          number
  holds_expired:              number
  opportunities_closed:       number
  opportunities_would_close:  number
  expiry_warnings_sent:       number
  expiry_warning_recipients:  number
  conflicts_auto_resolved:    number
  /** Won holds moved onto the truck LED runs them on (lib/ledTruckFollow.ts). */
  led_trucks_followed:        number
  /** Opportunities whose followed trucks haven't reached Salesforce yet; retried every sweep. */
  led_follow_sync_pending:    number
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
    return { checked: 0, committed: 0, released: 0, uncommitted: 0, changedOpportunities: [] as string[] }
  })

  // The reconcile released or un-committed holds on these: Salesforce's LED
  // Trucks and Hold Exp follow (every release path syncs).
  await syncOpportunities(sfdc.changedOpportunities, '[sfdc-reconcile]')

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
    job_number:   String(r.job_number   ?? ''),
    state:        String(r.state        ?? ''),
  }))

  // Deduplicate by truck_number + program + job_number + state + shift_start before conflict
  // detection. The source query can return multiple rows per program/date (one per
  // market row). The job number is part of the key: two LED programs can share a
  // name, and dropping one's row would lose the job number that tells a booking's
  // own program from a clash (findConflicts).
  const schedules = schedulesAll.filter((s, index, self) =>
    index === self.findIndex((t) =>
      t.truck_number === s.truck_number &&
      t.program      === s.program &&
      jobKey(t.job_number) === jobKey(s.job_number) &&
      (t.state ?? '') === (s.state ?? '') &&
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
    job_number:          linkedJob(h),
    state:               h.state,
  }))

  // A won hold follows the truck LED scheduled it on (lib/ledTruckFollow.ts),
  // before conflicts are judged, so they're judged on LED's truck. Salesforce's
  // LED Trucks follow too. Never fails the sweep. Only holds inside the dates
  // SCHEDULED_QUERY covers (a day in from each edge: its "today" is the
  // database's) can be judged.
  const today = centralDate(new Date())
  const shift = (n: number) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  const ledFollow = await followLedTrucks(
    holdsRaw.filter((h) => linkedJob(h)).map((h) => ({
      id: h.id, truck_number: h.truck_number, market: h.market, state: h.state, job_number: linkedJob(h),
      start_date: toDateStr(h.start_date), end_date: toDateStr(h.end_date),
      days_sold: daysSold(h.features, toDateStr(h.start_date), toDateStr(h.end_date)),
      sfdc_opportunity_id: h.sfdc_opportunity_id, created_by: h.created_by,
    })),
    // A deleted program or an archived truck is never a truck to follow.
    schedulesRaw.filter((r) => !Number(r.program_deleted) && !Number(r.truck_deleted)).map((r) => ({
      truck_number: String(r.truck_number ?? ''), job_number: String(r.job_number ?? ''), shift_start: toDateStr(r.shift_start),
      market: String(r.market ?? ''), state: String(r.state ?? ''), standard_market_name: String(r.standard_market_name ?? ''),
    })),
    today,
    holds,
    { from: shift(1 - SCHEDULED_WINDOW.pastDays), to: shift(SCHEDULED_WINDOW.aheadDays - 1) },
  ).catch((err) => {
    console.error('[scheduleCache] LED truck follow failed:', err)
    return { moved: [], opportunities: [] as string[] }
  })
  for (const m of ledFollow.moved) {
    const hold = holds.find((h) => h.id === m.holdId)
    if (hold) hold.truck_number = m.to
  }
  // Retried every sweep until Salesforce takes it (a mark on the moved holds).
  const ledFollowPending = await syncFollowedOpportunities(ledFollow.opportunities).catch((err) => {
    console.error('[scheduleCache] LED follow Salesforce sync failed:', err)
    return ledFollow.opportunities
  })

  // Before detection: a conflict whose window merely shifted is closed here and re-raised
  // against its new dates in the same pass.
  const reconciled = await reconcileConflicts(schedules, holds).catch((err) => {
    console.error('[scheduleCache] conflict reconcile failed:', err)
    return { resolved: 0, resolvedIds: [] as string[] }
  })

  await detectConflicts(schedules, holds, new Set(reconciled.resolvedIds))

  // Transport and deal-value metrics: where trucks sit before campaigns that
  // start soon, what actually ran each campaign that started, and won deals'
  // Amount changes. Last, so the fleet load and Salesforce reads never delay
  // conflict detection; independent (different holds), so in parallel.
  // Best-effort; never fails the sweep.
  // The two recorders that measure trucks share one fleet and GPS load.
  // Holds the sweep moved onto LED's truck are measured as swaps here too, on
  // the same fleet load (recordSwap never throws), but only before they start:
  // a running campaign's new truck is already in market, and its leg would
  // replace the quoted plan with a false LOCAL one.
  const measurer = sharedOriginMeasurer()
  const [metricsPrestart, metricsExecuted, metricsAmounts] = await Promise.all([
    recordPrestart(measurer), recordExecuted(measurer), recordAmountChanges(),
    ...ledFollow.moved
      .filter((m) => (holds.find((h) => h.id === m.holdId)?.start_date ?? '') > today)
      .map((m) => recordSwap(m.holdId, m.by, measurer)),
  ])
  if (metricsPrestart || metricsExecuted || metricsAmounts) {
    console.log(`[scheduleCache] metrics: ${metricsPrestart} pre-start snapshot(s), ${metricsExecuted} executed leg(s), ${metricsAmounts} amount change(s)`)
  }
  console.log(
    `[scheduleCache] refresh complete — ${expiry.expired} hold(s) expired ` +
    `(${expiry.opportunities_closed} opportunit${expiry.opportunities_closed === 1 ? 'y' : 'ies'} closed lost, ` +
    `${expiry.opportunities_would_close} would close in dry run), ` +
    `${att_soft_released} ATT_SOFT hold(s) released, ` +
    `${sfdc.committed} committed / ${sfdc.uncommitted} back to hold / ${sfdc.released} released from ${sfdc.checked} SFDC opportunit${sfdc.checked === 1 ? 'y' : 'ies'}, ` +
    `${warnings.warned} expiry warning(s) to ${warnings.recipients} user(s), ` +
    `${reconciled.resolved} conflict(s) auto-resolved, ` +
    `${ledFollow.moved.length} hold(s) moved to LED's truck, ${ledFollowPending.length} opportunit${ledFollowPending.length === 1 ? 'y' : 'ies'} awaiting its LED Trucks sync` +
    (warnings.skipped_no_email > 0 ? ` (${warnings.skipped_no_email} unwarned — no email)` : '')
  )

  return {
    att_soft_released,
    att_soft_created,
    att_soft_warnings,
    sfdc_committed:       sfdc.committed,
    sfdc_released:        sfdc.released,
    sfdc_uncommitted:     sfdc.uncommitted,
    sfdc_checked:         sfdc.checked,
    holds_expired:             expiry.expired,
    opportunities_closed:      expiry.opportunities_closed,
    opportunities_would_close: expiry.opportunities_would_close,
    expiry_warnings_sent:      warnings.warned,
    expiry_warning_recipients: warnings.recipients,
    conflicts_auto_resolved:   reconciled.resolved,
    led_trucks_followed:       ledFollow.moved.length,
    led_follow_sync_pending:   ledFollowPending.length,
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
 *
 * A client's waiting extension request (EXTENSION_REQUESTED) is not released
 * early: asking moves the booking's expires_at to the date asked (no later
 * than 3 days before it starts; app/api/client/hold-requests/[id]/extend), so
 * it is held until staff answer or that date passes, whichever comes first.
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

  // Then every opportunity a lapse touched (closed or not) gets LED Trucks and
  // Hold Exp from what the app still holds on it: blank when nothing, so a
  // later push can't re-create a lapsed truck (lib/sfdcBooking.ts
  // syncOpportunityLedWindow). After the close, so the stage never waits on
  // this write; the two touch different fields.
  const lapsedOn = new Set(stale.map(h => h.sfdc_opportunity_id).filter((id): id is string => Boolean(id)))
  await syncOpportunities([...lapsedOn], '[hold-expiry]')

  return { expired: stale.length, opportunities_closed, opportunities_would_close }
}

// At most this many Salesforce syncs in flight at once from the sweep, to stay
// well inside Salesforce's API concurrency.
const SYNC_CONCURRENCY = 5

/**
 * Syncs LED Trucks and Hold Exp for each opportunity, a few at a time. Each
 * sync never throws; a warning is logged. Two syncs of the same opportunity at
 * the same moment (a sweep and a staff edit) are not ordered: the later write
 * wins and the next change re-syncs it. Rare enough not to lock for.
 */
async function syncOpportunities(ids: string[], tag: string): Promise<void> {
  const queue = [...new Set(ids)]
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const warning = await syncOpportunityLedWindow(id)
      if (warning) console.warn(`${tag} ${id}: ${warning}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(SYNC_CONCURRENCY, queue.length) }, worker))
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
  /** The opportunity's job number (lib/ledJobs.ts); its own LED program isn't a conflict. */
  job_number?:         string | null
  /** Two-letter state: a program of the same job in another state is another market. */
  state?:              string | null
}

export interface ConflictSchedule {
  truck_number: string
  program:      string
  market:       string
  shift_start:  string  // YYYY-MM-DD
  shift_end:    string  // YYYY-MM-DD
  /** The LED program's job number; blocks merge only within one job number. */
  job_number?:  string
  /**
   * The market's state. One day of a job can be filed under markets in two
   * states; the day is a won hold's own if any of them is the hold's state
   * (dropOwnProgramRows). Not part of a merged block's identity.
   */
  state?:       string
}

// ── Conflict detection ────────────────────────────────────────────────────────

/** One (hold × schedule block) overlap, keyed the way dbo.schedule_conflicts rows are. */
export interface DetectedConflict {
  key:           string
  hold:          ConflictHold
  program:       string
  /** The LED program's job number as compared (jobKey), '' when it has none. */
  jobNumber:     string
  conflictStart: string  // YYYY-MM-DD
  conflictEnd:   string  // YYYY-MM-DD
}

/**
 * Identity of a conflict: which hold, on which truck, against which program, over which
 * window. The program is part of it: a reservation clashing with two programs is two
 * problems, and dismissing one must not hide the other. Compared trimmed, case- and
 * space-insensitive, so a cosmetic difference in the LED program name cannot split one
 * conflict into two (none has been seen in production; this keeps it that way).
 * So is the program's job number (jobKey, '' for none): two LED programs can share a
 * name on one truck, and each is its own problem. `jobNumber` null: a row recorded
 * before job numbers were (scheduled_job_number NULL), matched on the rest alone.
 */
export const programKey = (program: string) => program.trim().toLowerCase().replace(/\s+/g, ' ')

function conflictKey(holdId: string, truckNumber: string, program: string, jobNumber: string | null, start: string, end: string): string {
  return `${holdId}|${truckNumber}|${programKey(program)}|${jobNumber === null ? '' : `${jobNumber}|`}${start}|${end}`
}

/** A recorded conflict row's job number as conflictKey takes it: null for a row from before job numbers. */
const recordedJob = (v: string | null | undefined): string | null => v === null || v === undefined ? null : jobKey(v) ?? ''

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
    a.truck_number.localeCompare(b.truck_number) || a.program.localeCompare(b.program)
    || (jobKey(a.job_number) ?? '').localeCompare(jobKey(b.job_number) ?? '')
    || a.shift_start.localeCompare(b.shift_start))
  const out: ConflictSchedule[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    // Same-named programs with different job numbers stay apart, so a block
    // never carries one program's job number over another's days.
    if (last && last.truck_number === s.truck_number && last.program === s.program
      && jobKey(last.job_number) === jobKey(s.job_number)
      && s.shift_start <= nextDay(last.shift_end)) {
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
  const byTruck = new Map<string, ConflictSchedule[]>()
  for (const s of schedules) {
    const rows = byTruck.get(s.truck_number)
    if (rows) rows.push(s)
    else byTruck.set(s.truck_number, [s])
  }

  for (const hold of holds) {
    // The schedule within the hold's dates, less the won hold's own program
    // days (this booking scheduled in LED, not a clash with it), merged into
    // blocks. Dropped per day before merging, so a block of other work around
    // an own day still conflicts on its own days.
    const within = (byTruck.get(hold.truck_number) ?? []).filter(
      (s) => s.shift_start <= hold.end_date && s.shift_end >= hold.start_date
    )
    for (const sched of mergeScheduleBlocks(dropOwnProgramRows(within, hold))) {
      const conflictStart = hold.start_date > sched.shift_start ? hold.start_date : sched.shift_start
      const conflictEnd   = hold.end_date   < sched.shift_end   ? hold.end_date   : sched.shift_end
      const jobNumber     = jobKey(sched.job_number) ?? ''

      found.push({
        key:           conflictKey(hold.id, hold.truck_number, sched.program, jobNumber, conflictStart, conflictEnd),
        hold,
        program:       sched.program,
        jobNumber,
        conflictStart,
        conflictEnd,
      })
    }
  }

  return found
}

/**
 * A hold's truck's schedule rows less its own LED program days
 * (lib/jobNumber.ts isOwnLedProgram), judged per day and job: a day LED files
 * under markets in two states is the hold's own if either is the hold's
 * state, so its other row isn't left behind as a clash. Pure.
 */
export function dropOwnProgramRows(rows: ConflictSchedule[], hold: ConflictHold): ConflictSchedule[] {
  const job = jobKey(hold.job_number)
  if (!job) return rows
  const states = new Map<string, string[]>()
  for (const r of rows) {
    if (jobKey(r.job_number) !== job) continue
    const day = `${r.shift_start}|${r.shift_end}`
    const seen = states.get(day)
    if (seen) seen.push(r.state ?? '')
    else states.set(day, [r.state ?? ''])
  }
  return rows.filter((r) => !(jobKey(r.job_number) === job && isOwnLedProgram(hold,
    { start: r.shift_start, end: r.shift_end, job_number: r.job_number, state: r.state, states: states.get(`${r.shift_start}|${r.shift_end}`) })))
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

  const current = findConflicts(schedules, holds)
  const live = new Set(current.map((c) => c.key))
  // Rows recorded before job numbers match on the rest of the key.
  const liveAnyJob = new Set(current.map((c) =>
    conflictKey(c.hold.id, c.hold.truck_number, c.program, null, c.conflictStart, c.conflictEnd)))

  const active = await pool.request().query(`
    SELECT
      id, hold_id, truck_number, scheduled_program, scheduled_job_number,
      CONVERT(varchar(10), conflict_start, 120) AS conflict_start,
      CONVERT(varchar(10), conflict_end,   120) AS conflict_end
    FROM dbo.schedule_conflicts
    WHERE status = 'ACTIVE'
  `)

  let resolved = 0
  const resolvedIds: string[] = []

  for (const row of active.recordset as {
    id: string; hold_id: string; truck_number: string; scheduled_program: string | null; scheduled_job_number: string | null
    conflict_start: string; conflict_end: string
  }[]) {
    const job = recordedJob(row.scheduled_job_number)
    if ((job === null ? liveAnyJob : live).has(conflictKey(row.hold_id, row.truck_number, row.scheduled_program ?? '', job, row.conflict_start, row.conflict_end))) continue

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
    const { hold, program, jobNumber, conflictStart, conflictEnd } = conflict

    // What was recorded before for this reservation, truck, program and job
    // number: a person dismissing these dates, or the conflict already being
    // shown. A row recorded before job numbers counts for any job.
    const prior = (await pool
      .request()
      .input('holdId',      hold.id)
      .input('truckNumber', hold.truck_number)
      .input('from',        conflictStart)
      .input('to',          conflictEnd)
      .query(`
        SELECT id, scheduled_program, scheduled_job_number,
               CONVERT(varchar(10), conflict_start, 120) AS conflict_start,
               CONVERT(varchar(10), conflict_end,   120) AS conflict_end,
               status, resolved_by
        FROM dbo.schedule_conflicts
        WHERE hold_id = @holdId AND truck_number = @truckNumber
          AND conflict_start <= @to AND conflict_end >= @from
      `)).recordset.filter((p: { scheduled_program: string | null; scheduled_job_number: string | null }) =>
        programKey(p.scheduled_program ?? '') === programKey(program)
        && [null, jobNumber].includes(recordedJob(p.scheduled_job_number)))

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
      .input('scheduledJob',     jobNumber)
      .query(`
        INSERT INTO dbo.schedule_conflicts
          (id, hold_id, truck_number, conflict_start, conflict_end,
           hold_client, hold_market, scheduled_program, scheduled_job_number)
        VALUES
          (NEWID(), @holdId, @truckNumber, @conflictStart, @conflictEnd,
           @holdClient, @holdMarket, @scheduledProgram, @scheduledJob)
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

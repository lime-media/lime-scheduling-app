/**
 * AT&T soft holds — the placeholder that keeps AT&T's trucks reserved between
 * the months AT&T actually schedules them.
 *
 * AT&T work is booked under the agency 160over90 (ATT Fiber, ATT AIA, Alloy
 * Build, AT&T ECL ...), so it is matched by client, not program name.
 *
 * Which trucks are AT&T's: a truck with MORE than 5 days of 160over90 work in
 * the current month (scheduled days count). Through the 10th of the month the
 * prior month also counts, on its own — AT&T's commitments for a new month
 * drag into its first days. Months are never added together. From the 11th,
 * a truck with no 160over90 shifts this month is released. A day or two on
 * another client's program does not change any of this — the truck keeps its
 * soft hold, and the grid shows the real shift on those days.
 * (Soft holds are placeholders: conflict detection ignores them and quoting
 * treats them as displaceable, so the overlap blocks nothing.)
 *
 * The sync keeps a rolling window of THREE months — the current month (from
 * today) and the next two — and runs hourly from the cron sweep as well as
 * when the schedule grid loads. Each run, in order:
 *
 *   1. Releases soft holds from months before the current one.
 *   2. Removes duplicate soft holds (same truck, same start), keeping the
 *      oldest. Two grid loads at the same moment used to create two.
 *   3. Releases soft holds on trucks that are no longer AT&T's — unless the
 *      run looks wrong (no AT&T trucks at all, or a mass release), in which
 *      case it releases none and reports why (see releaseBlockedReason).
 *   4. Gives every AT&T truck a soft hold for each month of the window it
 *      does not already have.
 *
 * Every release is written to the audit log with its reason. A soft hold a
 * person released for a booking (lib/attSoftRelease.ts) stays released: step
 * 4 never re-creates it over those dates. Releases delete
 * only a row that is STILL a soft hold (an operator may have just promoted it
 * to a real hold), tolerate a row a concurrent run already removed, and never
 * abort the rest of the sync. Nothing is released for "not AT&T's" in a run
 * that could not create holds (no user to record them against).
 */

import { ATT_RELEASE_ORIGINATION } from '@/lib/attSoftRules'
import { prisma } from '@/lib/prisma'
import { query } from '@/lib/mssql'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'

import { ATT_CLIENT, ATT_MIN_DAYS, PRIOR_MONTH_GRACE_DAY, attLookback, freeRanges, isAttClient, isAttTruck, normalizeClient, releaseBlockedReason, softHoldWindow } from '@/lib/attSoftRules'
import { HIDDEN_TRUCKS } from '@/lib/hiddenTrucks'

export { ATT_CLIENT, isAttClient, softHoldWindow }

const iso = (d: Date) => d.toISOString().slice(0, 10)
const utc = (s: string) => new Date(s + 'T00:00:00Z')

type SoftHold = { id: string; truck_number: string; created_by: string; start_date: Date; end_date: Date; created_at: Date }

/**
 * Delete one soft hold, if it is still a soft hold. Returns whether it was
 * removed. A concurrent sync (cron + grid load) may already have deleted it;
 * an operator may have turned it into a real hold — neither is an error.
 */
async function release(hold: SoftHold, reason: string, detail: Record<string, unknown> = {}): Promise<boolean> {
  try {
    const { count } = await prisma.hold.deleteMany({ where: { id: hold.id, status: 'ATT_SOFT' } })
    if (count === 0) return false
    await prisma.auditLog.create({
      data: {
        action: 'DELETE_HOLD',
        truck_number: hold.truck_number,
        user_id: hold.created_by,
        hold_id: hold.id,
        details: JSON.stringify({ reason, ...detail }),
      },
    })
    console.log(`[att-soft] released ${hold.truck_number} ${iso(hold.start_date)}..${iso(hold.end_date)}: ${reason}`)
    return true
  } catch (err) {
    console.error(`[att-soft] release of ${hold.id} (${hold.truck_number}) failed:`, err)
    return false
  }
}

/** The SQL twin of isAttClient: normalised, "contains". */
const ATT_CLIENT_SQL = `LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(cl.client, ' ', ''), '-', ''), '.', ''), ',', ''), '_', '')) LIKE @clientLike`

/** Days each active truck worked (or is scheduled) for 160over90 in [from, to]. */
async function attDaysByTruck(from: string, to: string): Promise<Map<string, number>> {
  const rows = await query<{ truck_number: string; days: number }[]>(
    `
    SELECT t.truck_number, COUNT(DISTINCT CAST(ps.start_time AS DATE)) AS days
    FROM dbo.program_schedule ps
    JOIN dbo.trucks          t  ON t.truck_uid           = ps.truck_uid
    JOIN dbo.client_programs cp ON cp.client_program_uid = ps.client_program_uid
    JOIN dbo.clients         cl ON cl.client_uid         = cp.client_uid
    WHERE COALESCE(t.is_deleted, 0) = 0
      AND CAST(ps.start_time AS DATE) BETWEEN @from AND @to
      AND ${ATT_CLIENT_SQL}
    GROUP BY t.truck_number
    `,
    { from, to, clientLike: `%${normalizeClient(ATT_CLIENT)}%` },
  )
  // Hidden trucks (test and retired units) never get soft holds.
  return new Map(rows.filter(r => !HIDDEN_TRUCKS.has(String(r.truck_number))).map(r => [String(r.truck_number), Number(r.days)]))
}

export type SoftHoldSyncResult = {
  releasedPriorMonths: number
  releasedDuplicates: number
  releasedPremise: number
  created: number
  /** Trucks that currently count as AT&T's. */
  attTrucks: number
  window: string[]
  /** Why part of the run was skipped, if it was. Surfaced by the cron and the sync route. */
  warnings: string[]
}

/**
 * Bring AT&T soft holds in line with the schedule. Idempotent; safe to run
 * from several places at once (duplicates a race creates are removed by the
 * next run's step 2).
 *
 * `createdBy` is the user recorded on new holds; the cron passes none and the
 * Salesforce integration user is used.
 */
export async function syncAttSoftHolds(opts: { today?: string; createdBy?: string } = {}): Promise<SoftHoldSyncResult> {
  const today = opts.today ?? iso(new Date())
  const window = softHoldWindow(today)
  const monthStart = window[0].start.slice(0, 8) + '01'
  const warnings: string[] = []

  // Who new holds are recorded against — known BEFORE anything is released,
  // so a run that cannot create never releases trucks as "not AT&T's".
  let createdBy = opts.createdBy
  if (!createdBy) {
    const svc = await prisma.user.findFirst({ where: { email: SFDC_SERVICE_USER_EMAIL }, select: { id: true } })
    createdBy = svc?.id
  }

  // 1. Prior months — safe to clear in any run.
  const past = await prisma.hold.findMany({ where: { status: 'ATT_SOFT', end_date: { lt: utc(monthStart) } } })
  let releasedPriorMonths = 0
  for (const h of past) if (await release(h, 'att_soft_prior_month')) releasedPriorMonths++

  // 2. Duplicates: same truck, same start date; keep the oldest.
  const current = await prisma.hold.findMany({ where: { status: 'ATT_SOFT' }, orderBy: { created_at: 'asc' } })
  const seen = new Set<string>()
  let releasedDuplicates = 0
  const kept: SoftHold[] = []
  for (const h of current) {
    const key = `${h.truck_number}|${iso(h.start_date)}`
    if (seen.has(key)) { if (await release(h, 'att_soft_duplicate')) releasedDuplicates++; continue }
    seen.add(key)
    kept.push(h)
  }

  if (!createdBy) {
    warnings.push('No user to record new soft holds against (the Salesforce integration user is missing): nothing was released as "not AT&T\'s" and nothing was created.')
    console.error('[att-soft]', warnings[warnings.length - 1])
    return finish()
  }

  // 3. Trucks that are no longer AT&T's. (The pieces a release leaves either
  // side of a booking are ordinary soft holds and follow the same rule.)
  const lookback = attLookback(today)
  const curDays = await attDaysByTruck(lookback.current.from, lookback.current.to)
  const priorDays = lookback.prior ? await attDaysByTruck(lookback.prior.from, lookback.prior.to) : new Map<string, number>()
  const daysOf = (t: string) => ({ current: curDays.get(t) ?? 0, prior: priorDays.get(t) ?? 0 })
  const attTrucks = new Set([...new Set([...curDays.keys(), ...priorDays.keys()])].filter(t => isAttTruck(daysOf(t), lookback)))
  const toRelease = kept.filter(h => !attTrucks.has(h.truck_number))
  const blocked = releaseBlockedReason({ attTrucks: attTrucks.size, softHolds: kept.length, wouldRelease: toRelease.length })
  let releasedPremise = 0
  const live: SoftHold[] = kept.filter(h => attTrucks.has(h.truck_number))
  if (blocked) {
    // Keep every soft hold; a person should look before trucks are handed back.
    warnings.push(`Soft-hold release skipped: ${blocked}. Check the 160over90 schedule and client record.`)
    console.error('[att-soft]', warnings[warnings.length - 1])
    live.push(...toRelease)
  } else {
    for (const h of toRelease) {
      const ok = await release(h, 'att_soft_not_att_truck', {
        days_160over90: daysOf(h.truck_number), needs_more_than: ATT_MIN_DAYS,
        months: lookback.prior ? [lookback.prior.from.slice(0, 7), lookback.current.from.slice(0, 7)] : [lookback.current.from.slice(0, 7)],
        prior_month_counts_through_day: PRIOR_MONTH_GRACE_DAY,
      })
      if (ok) releasedPremise++
    }
  }

  // 4. Fill the window. For each truck and month, only the days not already
  // soft-held AND not released by someone for a booking (release rows,
  // lib/attSoftRelease.ts) get a soft hold — so a manual release sticks, and
  // the rest of that month is still reserved for AT&T.
  const releasedRows = await prisma.hold.findMany({
    where: { origination: ATT_RELEASE_ORIGINATION, end_date: { gte: utc(window[0].start) } },
    select: { truck_number: true, start_date: true, end_date: true },
  })
  const rangesFor = (rows: { truck_number: string; start_date: Date; end_date: Date }[], truck: string) =>
    rows.filter(r => r.truck_number === truck).map(r => ({ start: iso(r.start_date), end: iso(r.end_date) }))
  let created = 0
  for (const m of window) {
    for (const truck_number of [...attTrucks].sort()) {
      const gaps = freeRanges(m.start, m.end, [...rangesFor(live, truck_number), ...rangesFor(releasedRows, truck_number)])
      for (const g of gaps) {
        try {
          const h = await prisma.hold.create({
            // MIRROR PATH — no feasibility gate by design. This reflects AT&T's
            // standing reservation; infeasible holds are reported by
            // GET /api/holds/infeasible instead of being blocked.
            data: {
              truck_number,
              status: 'ATT_SOFT',
              client_name: 'AT&T',
              market: '',
              state: '',
              notes: `Auto soft hold – AT&T (160over90) – ${m.label}`,
              start_date: utc(g.start),
              end_date: utc(g.end),
              created_by: createdBy,
            },
          })
          live.push(h)
          created++
        } catch (err) {
          console.error(`[att-soft] create for ${truck_number} ${g.start}..${g.end} failed:`, err)
        }
      }
    }
  }
  return finish(attTrucks.size, releasedPremise, created)

  function finish(attCount = 0, premise = 0, made = 0): SoftHoldSyncResult {
    const result = { releasedPriorMonths, releasedDuplicates, releasedPremise: premise, created: made, attTrucks: attCount, window: window.map(w => `${w.start}..${w.end}`), warnings }
    console.log('[att-soft] sync', JSON.stringify(result))
    return result
  }
}

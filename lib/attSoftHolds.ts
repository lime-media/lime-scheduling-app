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
 *   3. Releases soft holds on trucks that are no longer AT&T's.
 *   4. Gives every AT&T truck a soft hold for each month of the window it
 *      does not already have.
 *
 * Every release is written to the audit log with its reason.
 */

import { prisma } from '@/lib/prisma'
import { query } from '@/lib/mssql'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'

import { ATT_CLIENT, ATT_MIN_DAYS, PRIOR_MONTH_GRACE_DAY, attLookback, isAttClient, isAttTruck, softHoldWindow } from '@/lib/attSoftRules'

export { ATT_CLIENT, isAttClient, softHoldWindow }

const iso = (d: Date) => d.toISOString().slice(0, 10)
const utc = (s: string) => new Date(s + 'T00:00:00Z')

type SoftHold = { id: string; truck_number: string; created_by: string; start_date: Date; end_date: Date; created_at: Date }

async function release(hold: SoftHold, reason: string, detail: Record<string, unknown> = {}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      action: 'DELETE_HOLD',
      truck_number: hold.truck_number,
      user_id: hold.created_by,
      hold_id: hold.id,
      details: JSON.stringify({ reason, ...detail }),
    },
  })
  await prisma.hold.delete({ where: { id: hold.id } })
  console.log(`[att-soft] released ${hold.truck_number} ${iso(hold.start_date)}..${iso(hold.end_date)}: ${reason}`)
}

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
      AND LOWER(LTRIM(RTRIM(cl.client))) = @client
    GROUP BY t.truck_number
    `,
    { from, to, client: ATT_CLIENT.toLowerCase() },
  )
  return new Map(rows.map(r => [r.truck_number, Number(r.days)]))
}

export type SoftHoldSyncResult = {
  releasedPriorMonths: number
  releasedDuplicates: number
  releasedPremise: number
  created: number
  /** Trucks that currently count as AT&T's. */
  attTrucks: number
  window: string[]
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

  // 1. Prior months.
  const past = await prisma.hold.findMany({ where: { status: 'ATT_SOFT', end_date: { lt: utc(monthStart) } } })
  for (const h of past) await release(h, 'att_soft_prior_month')

  // 2. Duplicates: same truck, same start date; keep the oldest.
  const current = await prisma.hold.findMany({ where: { status: 'ATT_SOFT' }, orderBy: { created_at: 'asc' } })
  const seen = new Set<string>()
  let releasedDuplicates = 0
  const kept: SoftHold[] = []
  for (const h of current) {
    const key = `${h.truck_number}|${iso(h.start_date)}`
    if (seen.has(key)) { await release(h, 'att_soft_duplicate'); releasedDuplicates++; continue }
    seen.add(key)
    kept.push(h)
  }

  // 3. Trucks that are no longer AT&T's.
  const lookback = attLookback(today)
  const curDays = await attDaysByTruck(lookback.current.from, lookback.current.to)
  const priorDays = lookback.prior ? await attDaysByTruck(lookback.prior.from, lookback.prior.to) : new Map<string, number>()
  const daysOf = (t: string) => ({ current: curDays.get(t) ?? 0, prior: priorDays.get(t) ?? 0 })
  const attTrucks = new Set([...new Set([...curDays.keys(), ...priorDays.keys()])].filter(t => isAttTruck(daysOf(t), lookback)))
  let releasedPremise = 0
  const live: SoftHold[] = []
  for (const h of kept) {
    if (attTrucks.has(h.truck_number)) { live.push(h); continue }
    await release(h, 'att_soft_not_att_truck', {
      days_160over90: daysOf(h.truck_number), needs_more_than: ATT_MIN_DAYS,
      months: lookback.prior ? [lookback.prior.from.slice(0, 7), lookback.current.from.slice(0, 7)] : [lookback.current.from.slice(0, 7)],
      prior_month_counts_through_day: PRIOR_MONTH_GRACE_DAY,
    })
    releasedPremise++
  }

  // 4. Create what the window is missing.
  let createdBy = opts.createdBy
  if (!createdBy) {
    const svc = await prisma.user.findFirst({ where: { email: SFDC_SERVICE_USER_EMAIL }, select: { id: true } })
    createdBy = svc?.id
  }
  let created = 0
  if (createdBy) {
    for (const m of window) {
      for (const truck_number of [...attTrucks].sort()) {
        const covered = live.some(h => h.truck_number === truck_number && iso(h.start_date) <= m.end && iso(h.end_date) >= m.start)
        if (covered) continue
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
            start_date: utc(m.start),
            end_date: utc(m.end),
            created_by: createdBy,
          },
        })
        live.push(h)
        created++
      }
    }
  } else {
    console.error('[att-soft] no user to record new soft holds against; creation skipped')
  }

  const result = { releasedPriorMonths: past.length, releasedDuplicates, releasedPremise, created, attTrucks: attTrucks.size, window: window.map(w => `${w.start}..${w.end}`) }
  console.log('[att-soft] sync', JSON.stringify(result))
  return result
}

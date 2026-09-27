/**
 * AT&T soft holds — the placeholder that keeps AT&T's trucks reserved between
 * the months AT&T actually schedules them.
 *
 * AT&T work is booked under the agency 160over90 (ATT Fiber, ATT AIA, Alloy
 * Build, AT&T ECL ...), so a truck is AT&T's when its most recent work is ANY
 * 160over90 program. Matching the client, not program names, is what catches
 * "Alloy Build" and "AT&T ECL ..." (neither starts with "ATT").
 *
 * The sync keeps a rolling window of THREE months — the current month and the
 * next two — and runs hourly from the cron sweep as well as when the schedule
 * grid loads. Each run, in order:
 *
 *   1. Releases soft holds from months before the current one.
 *   2. Removes duplicate soft holds (same truck, same start), keeping the
 *      oldest. Two grid loads at the same moment used to create two.
 *   3. Releases soft holds whose premise is gone: another client's shift now
 *      falls inside the hold, or the truck's work just before it was not
 *      160over90.
 *   4. Creates the missing ones. For each month in the window, a truck gets a
 *      soft hold when its latest shift before the hold starts is a 160over90
 *      program and no other client has it booked during the hold. The current
 *      month's hold runs from today; later months cover the whole month.
 *      160over90's own shifts inside the hold are fine — the grid shows the
 *      real shift on those days.
 *
 * Every release is written to the audit log.
 */

import { prisma } from '@/lib/prisma'
import { query } from '@/lib/mssql'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'

import { ATT_CLIENT, isAttClient, softHoldWindow } from '@/lib/attSoftRules'

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

/** Trucks eligible for a soft hold over [start, end]. */
async function eligibleTrucks(start: string, end: string): Promise<string[]> {
  const rows = await query<{ truck_number: string }[]>(
    `
    WITH latest AS (
      SELECT
        t.truck_number,
        cl.client,
        ROW_NUMBER() OVER (PARTITION BY t.truck_number ORDER BY ps.start_time DESC) AS rn
      FROM dbo.program_schedule ps
      JOIN dbo.trucks          t  ON t.truck_uid           = ps.truck_uid
      JOIN dbo.client_programs cp ON cp.client_program_uid = ps.client_program_uid
      LEFT JOIN dbo.clients    cl ON cl.client_uid         = cp.client_uid
      WHERE COALESCE(t.is_deleted, 0) = 0
        AND CAST(ps.start_time AS DATE) < @start
    )
    SELECT truck_number
    FROM latest
    WHERE rn = 1
      AND LOWER(LTRIM(RTRIM(client))) = @client
      AND truck_number NOT IN (
        SELECT t2.truck_number
        FROM dbo.program_schedule ps2
        JOIN dbo.trucks          t2  ON t2.truck_uid           = ps2.truck_uid
        JOIN dbo.client_programs cp2 ON cp2.client_program_uid = ps2.client_program_uid
        LEFT JOIN dbo.clients    cl2 ON cl2.client_uid         = cp2.client_uid
        WHERE CAST(ps2.start_time AS DATE) BETWEEN @start AND @end
          AND COALESCE(LOWER(LTRIM(RTRIM(cl2.client))), '') <> @client
      )
    `,
    { start, end, client: ATT_CLIENT.toLowerCase() },
  )
  return rows.map(r => r.truck_number)
}

/** Clients of the shifts in [start, end] for one truck, and of its latest shift before start. */
async function premise(truckNumber: string, start: string, end: string): Promise<{ otherClientShift: string | null; priorClient: string | null; priorProgram: string | null }> {
  const inside = await query<{ program: string; client: string | null }[]>(
    `
    SELECT cp.program, cl.client
    FROM dbo.program_schedule ps
    JOIN dbo.trucks          t  ON t.truck_uid           = ps.truck_uid
    JOIN dbo.client_programs cp ON cp.client_program_uid = ps.client_program_uid
    LEFT JOIN dbo.clients    cl ON cl.client_uid         = cp.client_uid
    WHERE t.truck_number = @truckNumber
      AND CAST(ps.start_time AS DATE) BETWEEN @start AND @end
    `,
    { truckNumber, start, end },
  )
  const other = inside.find(r => !isAttClient(r.client))
  const prior = await query<{ program: string; client: string | null }[]>(
    `
    SELECT TOP 1 cp.program, cl.client
    FROM dbo.program_schedule ps
    JOIN dbo.trucks          t  ON t.truck_uid           = ps.truck_uid
    JOIN dbo.client_programs cp ON cp.client_program_uid = ps.client_program_uid
    LEFT JOIN dbo.clients    cl ON cl.client_uid         = cp.client_uid
    WHERE t.truck_number = @truckNumber
      AND CAST(ps.start_time AS DATE) < @start
    ORDER BY ps.start_time DESC
    `,
    { truckNumber, start },
  )
  return {
    otherClientShift: other ? `${other.program} (${other.client ?? 'no client'})` : null,
    priorClient: prior[0]?.client ?? null,
    priorProgram: prior[0]?.program ?? null,
  }
}

export type SoftHoldSyncResult = {
  releasedPriorMonths: number
  releasedDuplicates: number
  releasedPremise: number
  created: number
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

  // 3. Premise gone. Only the part of a hold from today on matters.
  let releasedPremise = 0
  const live: SoftHold[] = []
  for (const h of kept) {
    const from = iso(h.start_date) > today ? iso(h.start_date) : today
    const to = iso(h.end_date)
    if (to < from) { live.push(h); continue }
    const p = await premise(h.truck_number, from, to)
    if (p.otherClientShift) {
      await release(h, 'att_soft_superseded_by_other_client', { shift: p.otherClientShift })
      releasedPremise++
    } else if (p.priorClient !== null && !isAttClient(p.priorClient)) {
      await release(h, 'att_soft_prior_work_not_160over90', { program: p.priorProgram, client: p.priorClient })
      releasedPremise++
    } else {
      live.push(h)
    }
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
      const trucks = await eligibleTrucks(m.start, m.end)
      for (const truck_number of trucks) {
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

  const result = { releasedPriorMonths: past.length, releasedDuplicates, releasedPremise, created, window: window.map(w => `${w.start}..${w.end}`) }
  console.log('[att-soft] sync', JSON.stringify(result))
  return result
}

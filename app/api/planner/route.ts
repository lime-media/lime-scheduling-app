/**
 * GET /api/planner — everything the ops planner shows, for last week through
 * six weeks ahead, or ?from=YYYY-MM-DD&to=YYYY-MM-DD for a range the person
 * picked (whole Sunday-to-Saturday weeks, at most 13): every truck's scheduled shifts with
 * hours and driver, maintenance, reservations, committed reservations, client
 * hold requests, AT&T soft holds and open days. Staff only.
 *
 * The pivoting happens in the browser (lib/planner/build.ts), so switching
 * between truck, driver, client and campaign needs no round trip.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { prisma } from '@/lib/prisma'
import { query } from '@/lib/mssql'
import { activeHoldWhere } from '@/lib/holdFilters'
import { ALL_TRUCKS_QUERY } from '@/lib/scheduleQuery'
import { HIDDEN_TRUCKS } from '@/lib/availabilityEngine'
import { isSfdcConfigured, sfdcQuery } from '@/lib/salesforceClient'
import { parseQuoteFeatures } from '@/lib/quoteFeatures'
import { buildEntries, plannerRange, plannerWindow, weekStart, type PlannerHold, type PlannerShift } from '@/lib/planner/build'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const iso = (d: Date) => d.toISOString().slice(0, 10)

const SHIFTS_QUERY = `
SELECT
    t.truck_number,
    CAST(ps.start_time AS DATE) AS shift_date,
    COALESCE(ps.shift_duration_in_mins, DATEDIFF(MINUTE, ps.start_time, ps.end_time)) AS minutes,
    CAST(ps.driver_uid AS NVARCHAR(64)) AS driver_uid,
    COALESCE(cl.client,  '') AS client,
    COALESCE(cp.program, '') AS program,
    NULLIF(LTRIM(RTRIM(cp.job_number)), '') AS job_number,
    COALESCE(NULLIF(cpm.standard_market_name, ''), cpm.market, '') AS market
FROM dbo.program_schedule ps
JOIN dbo.trucks t
    ON  t.truck_uid = ps.truck_uid
LEFT JOIN dbo.client_programs cp
    ON  cp.client_program_uid = ps.client_program_uid
LEFT JOIN dbo.clients cl
    ON  cl.client_uid = cp.client_uid
LEFT JOIN dbo.client_program_markets cpm
    ON  cpm.client_program_market_uid = ps.client_program_market_uid
WHERE COALESCE(t.is_deleted, 0) = 0
  AND CAST(ps.start_time AS DATE) BETWEEN @from AND @to
`

/**
 * Where driver names live is not something this app has read before, so it is
 * found from the schema rather than assumed: a table (other than
 * program_schedule) with a driver_uid column and a name column. Cached per
 * process. Null when none is found; drivers then show by id.
 */
type DriverSource = { table: string; uid: string; name: string } | null
let driverSource: DriverSource | undefined

async function findDriverSource(): Promise<DriverSource> {
  if (driverSource !== undefined) return driverSource
  try {
    const cols = await query<{ table_name: string; column_name: string }[]>(`
      SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name
      FROM INFORMATION_SCHEMA.COLUMNS c
      WHERE c.TABLE_SCHEMA = 'dbo'
        AND c.TABLE_NAME IN (
          SELECT TABLE_NAME FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = 'dbo' AND COLUMN_NAME = 'driver_uid' AND TABLE_NAME <> 'program_schedule'
        )
    `)
    const byTable = new Map<string, Set<string>>()
    for (const c of cols) byTable.set(c.table_name, (byTable.get(c.table_name) ?? new Set()).add(c.column_name.toLowerCase()))
    // Prefer a table named like drivers; then any with a usable name column.
    const tables = [...byTable.keys()].sort((a, b) => Number(!/driver/i.test(a)) - Number(!/driver/i.test(b)))
    for (const table of tables) {
      const c = byTable.get(table)!
      const name = c.has('first_name') && c.has('last_name') ? "CONCAT(first_name, ' ', last_name)"
        : c.has('driver_name') ? 'driver_name' : c.has('full_name') ? 'full_name' : c.has('name') ? 'name' : null
      if (name) { driverSource = { table, uid: 'driver_uid', name }; return driverSource }
    }
    driverSource = null
  } catch (err) {
    console.error('[planner] driver table lookup failed:', err)
    driverSource = null
  }
  return driverSource
}

async function driverNames(ids: string[]): Promise<Map<string, string>> {
  const src = await findDriverSource()
  if (!src || ids.length === 0) return new Map()
  const rows = await query<{ uid: string; name: string }[]>(
    `SELECT CAST(${src.uid} AS NVARCHAR(64)) AS uid, LTRIM(RTRIM(${src.name})) AS name FROM dbo.[${src.table.replace(/]/g, '')}]`,
  )
  const want = new Set(ids.map(i => i.toLowerCase()))
  return new Map(rows.filter(r => r.uid && r.name && want.has(r.uid.toLowerCase())).map(r => [r.uid.toLowerCase(), r.name]))
}

async function opportunityNames(ids: string[]): Promise<Map<string, { name: string; jobNumber: string | null }>> {
  if (ids.length === 0 || !isSfdcConfigured()) return new Map()
  const out = new Map<string, { name: string; jobNumber: string | null }>()
  // Per chunk, so one failed query never discards the names already found.
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200).filter(id => /^[A-Za-z0-9]{15,18}$/.test(id))
    if (chunk.length === 0) continue
    try {
      const rows = await sfdcQuery<{ Id: string; Name: string; Job_Number__c: string | null }>(`SELECT Id, Name, Job_Number__c FROM Opportunity WHERE Id IN (${chunk.map(id => `'${id}'`).join(',')})`)
      for (const r of rows) out.set(r.Id, { name: r.Name, jobNumber: r.Job_Number__c?.trim() || null })
    } catch (err) {
      console.error('[planner] opportunity names failed for a chunk:', err)
    }
  }
  return out
}

export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ?from=YYYY-MM-DD&to=YYYY-MM-DD: the range the person picked, widened to
  // whole Sunday-to-Saturday weeks (plannerRange). ?from= alone: eight weeks
  // from that date's week. Neither: last week through six weeks ahead.
  const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v))
  const fromParam = req.nextUrl.searchParams.get('from')
  const toParam = req.nextUrl.searchParams.get('to')
  const window = isDate(fromParam)
    ? plannerRange(fromParam, isDate(toParam) ? toParam : iso(new Date(Date.parse(weekStart(fromParam) + 'T00:00:00Z') + (8 * 7 - 1) * 864e5)))
    : plannerWindow(iso(new Date()))

  try {
    const [trucksRaw, shiftsRaw, holds] = await Promise.all([
      query<{ truck_number: string }[]>(ALL_TRUCKS_QUERY),
      query<{ truck_number: string; shift_date: Date | string; minutes: number | null; driver_uid: string | null; client: string; program: string; job_number: string | null; market: string }[]>(
        SHIFTS_QUERY, { from: window.from, to: window.to }),
      prisma.hold.findMany({
        where: { ...activeHoldWhere(), start_date: { lte: new Date(window.to) }, end_date: { gte: new Date(window.from) } },
        select: { id: true, truck_number: true, start_date: true, end_date: true, status: true, source: true, client_name: true, market: true, state: true, features: true, sfdc_opportunity_id: true, campaign_group_id: true },
      }),
    ])

    const trucks = [...new Set(trucksRaw.map(r => String(r.truck_number)))].filter(t => !HIDDEN_TRUCKS.has(t)).sort()
    const driverIds = [...new Set(shiftsRaw.map(r => r.driver_uid).filter((x): x is string => Boolean(x)))]
    const oppIds = [...new Set(holds.map(h => h.sfdc_opportunity_id).filter((x): x is string => Boolean(x)))]
    const [names, opps, src] = await Promise.all([driverNames(driverIds), opportunityNames(oppIds), findDriverSource()])

    const shifts: PlannerShift[] = shiftsRaw
      .filter(r => !HIDDEN_TRUCKS.has(String(r.truck_number)))
      .map(r => ({
        truck: String(r.truck_number),
        date: r.shift_date instanceof Date ? iso(r.shift_date) : String(r.shift_date).slice(0, 10),
        minutes: r.minutes === null ? null : Number(r.minutes),
        driverId: r.driver_uid,
        driverName: r.driver_uid ? names.get(r.driver_uid.toLowerCase()) ?? null : null,
        client: r.client,
        program: r.program,
        jobNumber: r.job_number,
        market: r.market,
      }))

    const plannerHolds: PlannerHold[] = holds
      .filter(h => !HIDDEN_TRUCKS.has(h.truck_number) && (h.status === 'HOLD' || h.status === 'COMMITTED' || h.status === 'ATT_SOFT'))
      .map(h => {
        const f = parseQuoteFeatures(h.features)
        return {
          id: h.id,
          truck: h.truck_number,
          start: iso(h.start_date),
          end: iso(h.end_date),
          status: h.status as PlannerHold['status'],
          source: h.source,
          client: h.client_name,
          market: h.market?.includes(',') || !h.state ? h.market : [h.market, h.state].filter(Boolean).join(', '),
          hours: typeof f?.operatingHours === 'number' ? f.operatingHours : null,
          opportunityId: h.sfdc_opportunity_id,
          opportunityName: h.sfdc_opportunity_id ? opps.get(h.sfdc_opportunity_id)?.name ?? null : null,
          jobNumber: h.sfdc_opportunity_id ? opps.get(h.sfdc_opportunity_id)?.jobNumber ?? null : null,
          campaignGroupId: h.campaign_group_id,
        }
      })

    const entries = buildEntries({ trucks, days: window.days, shifts, holds: plannerHolds })
    return NextResponse.json({
      window,
      trucks,
      entries,
      meta: {
        driverSource: src ? src.table : null,
        driversNamed: names.size,
        driversSeen: driverIds.length,
        opportunitiesNamed: opps.size,
        opportunitiesSeen: oppIds.length,
      },
    })
  } catch (err) {
    console.error('[planner] failed:', err)
    return NextResponse.json({ error: 'The planner could not be loaded.' }, { status: 500 })
  }
}

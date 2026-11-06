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
import { ALL_TRUCKS_QUERY, liveProgram, shiftDay, shiftDayIn } from '@/lib/scheduleQuery'
import { centralDate } from '@/lib/dateOnly'
import { HIDDEN_TRUCKS } from '@/lib/availabilityEngine'
import { isSfdcConfigured, sfdcQueryOptionalField } from '@/lib/salesforceClient'
import { parseQuoteFeatures } from '@/lib/quoteFeatures'
import { buildEntries, plannerRange, plannerWindow, weekStart, type PlannerHold, type PlannerShift } from '@/lib/planner/build'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const iso = (d: Date) => d.toISOString().slice(0, 10)

const SHIFTS_QUERY = `
SELECT
    t.truck_number,
    ${shiftDay('ps.start_time')} AS shift_date,
    COALESCE(ps.shift_duration_in_mins, DATEDIFF(MINUTE, ps.start_time, ps.end_time)) AS minutes,
    CAST(ps.driver_uid AS NVARCHAR(64)) AS driver_uid,
    NULLIF(LTRIM(RTRIM(du.user_name)), '') AS driver_name,
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
-- Drivers are LED users: the same join LED's program-schedule views use.
LEFT JOIN dbo.users du
    ON  du.user_uid = ps.driver_uid
WHERE COALESCE(t.is_deleted, 0) = 0
  AND ${liveProgram()}
  AND ${shiftDayIn({ from: '@from', to: '@to' })}
`

async function opportunityNames(ids: string[]): Promise<Map<string, { name: string; jobNumber: string | null }>> {
  if (ids.length === 0 || !isSfdcConfigured()) return new Map()
  const out = new Map<string, { name: string; jobNumber: string | null }>()
  // Per chunk, so one failed query never discards the names already found.
  // A refused Job_Number__c is asked for once, not per chunk.
  let tryJob = true
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200).filter(id => /^[A-Za-z0-9]{15,18}$/.test(id))
    if (chunk.length === 0) continue
    try {
      // Names still load if Salesforce refuses Job_Number__c.
      const { rows, refused }: { rows: { Id: string; Name: string; Job_Number__c?: string | null }[]; refused: boolean } = await sfdcQueryOptionalField<{ Id: string; Name: string; Job_Number__c?: string | null }>('Job_Number__c', (job) =>
        `SELECT Id, Name${job ? ', Job_Number__c' : ''} FROM Opportunity WHERE Id IN (${chunk.map(id => `'${id}'`).join(',')})`, tryJob)
      tryJob = !refused
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
    : plannerWindow(centralDate(new Date()))

  try {
    const [trucksRaw, shiftsRaw, holds] = await Promise.all([
      query<{ truck_number: string }[]>(ALL_TRUCKS_QUERY),
      query<{ truck_number: string; shift_date: Date | string; minutes: number | null; driver_uid: string | null; driver_name: string | null; client: string; program: string; job_number: string | null; market: string }[]>(
        SHIFTS_QUERY, { from: window.from, to: window.to }),
      prisma.hold.findMany({
        where: { ...activeHoldWhere(), start_date: { lte: new Date(window.to) }, end_date: { gte: new Date(window.from) } },
        select: { id: true, truck_number: true, start_date: true, end_date: true, status: true, source: true, client_name: true, market: true, state: true, features: true, sfdc_opportunity_id: true, campaign_group_id: true },
      }),
    ])

    const trucks = [...new Set(trucksRaw.map(r => String(r.truck_number)))].filter(t => !HIDDEN_TRUCKS.has(t)).sort()
    const driverIds = [...new Set(shiftsRaw.map(r => r.driver_uid).filter((x): x is string => Boolean(x)))]
    const oppIds = [...new Set(holds.map(h => h.sfdc_opportunity_id).filter((x): x is string => Boolean(x)))]
    const opps = await opportunityNames(oppIds)

    const shifts: PlannerShift[] = shiftsRaw
      .filter(r => !HIDDEN_TRUCKS.has(String(r.truck_number)))
      .map(r => ({
        truck: String(r.truck_number),
        date: r.shift_date instanceof Date ? iso(r.shift_date) : String(r.shift_date).slice(0, 10),
        minutes: r.minutes === null ? null : Number(r.minutes),
        driverId: r.driver_uid,
        driverName: r.driver_uid ? r.driver_name : null,
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
        driversNamed: new Set(shiftsRaw.filter(r => r.driver_uid && r.driver_name).map(r => r.driver_uid!.toLowerCase())).size,
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

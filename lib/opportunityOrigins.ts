/**
 * Where LED opportunities are made: in the app, or directly in Salesforce.
 *
 * Every booking should go through the app, so an LED opportunity made in
 * Salesforce by hand is the number Ops watches (/ops/opportunities). Salesforce
 * can't say which is which on its own: the app creates opportunities as its
 * integration user, a real person's Salesforce user, so Created By mixes the
 * app with that person's own. So an opportunity counts as made in the app when:
 *   - the app recorded making it (app_created_opportunities), or
 *   - it carries Created_In_App__c, once that field exists in Salesforce, or
 *   - (opportunities from before the record) an app reservation on it was made
 *     within OPPORTUNITY_MATCH_MINUTES of it: the app makes the reservation
 *     and the opportunity in one go. Shown as "matched".
 * Anything else is made directly in Salesforce.
 */
import { prisma } from '@/lib/prisma'
import { centralDate } from '@/lib/dateOnly'
import { CREATED_IN_APP_FIELD, createOpportunity, sfdcQueryAll, type CreateOpportunityInput, type SfdcOpportunityResult } from '@/lib/salesforceClient'

/** How close an app reservation's creation must be to an opportunity's to count it as made in the app. */
export const OPPORTUNITY_MATCH_MINUTES = 5

export type OpportunityPath = 'staff' | 'client' | 'multi-market'

/**
 * Create an opportunity for a booking and record that the app made it. The
 * record is best-effort: a failure is logged and never fails the booking.
 */
export async function createAppOpportunity(
  input: CreateOpportunityInput,
  made: { createdBy: string | null; path: OpportunityPath },
): Promise<SfdcOpportunityResult> {
  const result = await createOpportunity(input)
  if (result.success && result.id) {
    await prisma.createdOpportunity.create({
      data: { sfdc_opportunity_id: result.id, created_by: made.createdBy, path: made.path },
    }).catch(err => console.error(`[opportunity-origins] couldn't record ${result.id} as made in the app:`, err))
  }
  return result
}

export type OriginOpportunity = {
  id: string
  createdAt: string          // ISO instant
  createdBy: string
  owner: string
  stage: string
  createdInApp?: boolean     // Created_In_App__c, when Salesforce has it
}

export type Origin = 'app' | 'app_matched' | 'salesforce'

/**
 * Where one opportunity was made. `recorded`: ids the app recorded making.
 * `appHoldTimes`: when each app reservation (staff or client) on it was made.
 * `recordSince`: when the app began recording; an opportunity made since then
 * that the app didn't record was made in Salesforce, even if a reservation was
 * attached to it minutes later (the match only covers the time before). Pure.
 */
export function opportunityOrigin(
  opp: OriginOpportunity,
  recorded: Set<string>,
  appHoldTimes: Map<string, Date[]>,
  recordSince: Date | null = null,
  matchMinutes = OPPORTUNITY_MATCH_MINUTES,
): Origin {
  const id = opp.id.slice(0, 15)
  if (recorded.has(id) || opp.createdInApp) return 'app'
  const made = Date.parse(opp.createdAt)
  if (recordSince && made >= recordSince.getTime()) return 'salesforce'
  const near = (appHoldTimes.get(id) ?? []).some(t => Math.abs(t.getTime() - made) <= matchMinutes * 60_000)
  return near ? 'app_matched' : 'salesforce'
}

/** The Monday (YYYY-MM-DD) of the Central week an instant falls in. Pure. */
export function centralWeekStart(instant: Date): string {
  const day = centralDate(instant)
  const d = new Date(day + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

export type OriginSummary = {
  total: number
  inApp: number
  matched: number          // of inApp: counted by the reservation-time match
  direct: number
  directPct: number
  weeks: { week: string; inApp: number; direct: number }[]
  byCreator: { createdBy: string; direct: number }[]
  direct_opportunities: (OriginOpportunity & { week: string })[]
}

/**
 * Totals, a week-by-week series (Central weeks, every week from `fromWeek`
 * to `toWeek` even when empty) and the direct ones by who made them. Pure.
 */
export function summarizeOrigins(
  rows: { opp: OriginOpportunity; origin: Origin }[],
  fromWeek: string,
  toWeek: string,
): OriginSummary {
  const weeks = new Map<string, { inApp: number; direct: number }>()
  for (let d = new Date(fromWeek + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= toWeek; d.setUTCDate(d.getUTCDate() + 7)) {
    weeks.set(d.toISOString().slice(0, 10), { inApp: 0, direct: 0 })
  }
  const byCreator = new Map<string, number>()
  const direct: (OriginOpportunity & { week: string })[] = []
  let inApp = 0, matched = 0
  for (const { opp, origin } of rows) {
    const week = centralWeekStart(new Date(opp.createdAt))
    const w = weeks.get(week) ?? { inApp: 0, direct: 0 }
    weeks.set(week, w)
    if (origin === 'salesforce') {
      w.direct++
      byCreator.set(opp.createdBy, (byCreator.get(opp.createdBy) ?? 0) + 1)
      direct.push({ ...opp, week })
    } else {
      w.inApp++
      inApp++
      if (origin === 'app_matched') matched++
    }
  }
  const total = rows.length
  return {
    total,
    inApp,
    matched,
    direct: direct.length,
    directPct: total ? Math.round((direct.length / total) * 1000) / 10 : 0,
    weeks: [...weeks].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({ week, ...v })),
    byCreator: [...byCreator].map(([createdBy, n]) => ({ createdBy, direct: n })).sort((a, b) => b.direct - a.direct || a.createdBy.localeCompare(b.createdBy)),
    direct_opportunities: direct.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }
}

// SQL Server takes at most 2100 parameters per query. Each id is sent in both
// its 18- and 15-character forms (1,800), leaving room for the queries' other
// where values.
const IN_CHUNK = 900

type SoqlOpportunity = {
  Id: string
  CreatedDate: string
  StageName: string
  CreatedBy?: { Name?: string } | null
  Owner?: { Name?: string } | null
  Created_In_App__c?: boolean | null
}

/**
 * LED opportunities created in Salesforce from the Central week of `from` to
 * the end of `to` (YYYY-MM-DD), each with where it was made. Reads Salesforce
 * and the app's database; throws if Salesforce can't be read.
 */
export async function opportunityOrigins(from: string, to: string): Promise<OriginSummary & { from: string; to: string; truncated: boolean; markerReadable: boolean }> {
  const fromWeek = centralWeekStart(new Date(from + 'T12:00:00Z'))
  // A day wider each side in UTC, then cut to Central days below.
  const lo = new Date(Date.parse(fromWeek + 'T00:00:00Z') - 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z')
  const hi = new Date(Date.parse(to + 'T00:00:00Z') + 2 * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z')
  const soql = (marker: boolean) =>
    `SELECT Id, CreatedDate, StageName, CreatedBy.Name, Owner.Name${marker ? `, ${CREATED_IN_APP_FIELD}` : ''} FROM Opportunity`
    // Newest first, so a range too large to read whole loses its oldest rows, not its latest weeks.
    + ` WHERE Asset_Type__c = 'LED' AND CreatedDate >= ${lo} AND CreatedDate < ${hi} ORDER BY CreatedDate DESC`

  // When the app began recording: the reservation-time match only counts before it.
  const firstRecordRead = prisma.createdOpportunity.findFirst({ orderBy: { created_at: 'asc' }, select: { created_at: true } })
  firstRecordRead.catch(() => {}) // awaited below; this only stops an unhandled rejection if Salesforce throws first
  // Created_In_App__c only exists once it's added in Salesforce: read without it until then.
  let markerReadable = true
  let read: { rows: SoqlOpportunity[]; truncated: boolean }
  try {
    read = await sfdcQueryAll<SoqlOpportunity>(soql(true))
  } catch (err) {
    console.warn(`[opportunity-origins] ${CREATED_IN_APP_FIELD} not readable; counting without it:`, err)
    markerReadable = false
    read = await sfdcQueryAll<SoqlOpportunity>(soql(false))
  }

  const opps: OriginOpportunity[] = read.rows
    .filter(r => {
      const day = centralDate(new Date(r.CreatedDate))
      return day >= fromWeek && day <= to
    })
    .map(r => ({
      id: r.Id,
      createdAt: new Date(r.CreatedDate).toISOString(),
      createdBy: r.CreatedBy?.Name ?? 'Unknown',
      owner: r.Owner?.Name ?? 'Unknown',
      stage: r.StageName,
      ...(markerReadable ? { createdInApp: r.Created_In_App__c === true } : {}),
    }))

  // The app's record, and its reservations' creation times for the match.
  // Salesforce ids are compared on their first 15 characters (the 18-character
  // form only adds a case checksum).
  const ids = opps.map(o => o.id)
  const recorded = new Set<string>()
  const appHoldTimes = new Map<string, Date[]>()
  const firstRecord = await firstRecordRead
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    // The app may have stored an id in either form (a pasted 15-character id).
    const slice = ids.slice(i, i + IN_CHUNK).flatMap(id => [id, id.slice(0, 15)])
    const [made, holds, booked] = await Promise.all([
      prisma.createdOpportunity.findMany({ where: { sfdc_opportunity_id: { in: slice } }, select: { sfdc_opportunity_id: true } }),
      prisma.hold.findMany({
        where: { sfdc_opportunity_id: { in: slice }, source: { in: ['INTERNAL', 'CLIENT'] } },
        select: { sfdc_opportunity_id: true, created_at: true },
      }),
      // A revision replaces a booking's holds (new creation times), but its
      // BOOKED deal values keep when it was booked.
      prisma.dealValue.findMany({
        where: { sfdc_opportunity_id: { in: slice }, event: 'BOOKED' },
        select: { sfdc_opportunity_id: true, captured_at: true },
      }),
    ])
    for (const m of made) recorded.add(m.sfdc_opportunity_id.slice(0, 15))
    for (const [id, at] of [...holds.map(h => [h.sfdc_opportunity_id!, h.created_at] as const), ...booked.map(b => [b.sfdc_opportunity_id!, b.captured_at] as const)]) {
      const key = id.slice(0, 15)
      const times = appHoldTimes.get(key)
      if (times) times.push(at)
      else appHoldTimes.set(key, [at])
    }
  }

  const rows = opps.map(opp => ({ opp, origin: opportunityOrigin(opp, recorded, appHoldTimes, firstRecord?.created_at ?? null) }))
  return { ...summarizeOrigins(rows, fromWeek, centralWeekStart(new Date(to + 'T12:00:00Z'))), from: fromWeek, to, truncated: read.truncated, markerReadable }
}

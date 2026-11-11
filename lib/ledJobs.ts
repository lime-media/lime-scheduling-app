/**
 * Linking a won reservation to its LED program by job number.
 *
 * A won deal gets a job number in Salesforce (Opportunity.Job_Number__c), and
 * ops gives its LED program the same one (dbo.client_programs.job_number). The
 * opportunity reconcile copies it onto each hold (`sfdc_job_number`), which
 * ties the two together without any change to the LED app:
 *
 * - An LED program carrying a hold's own job number is that booking being
 *   scheduled, not a clash with it (lib/scheduleCache.ts findConflicts).
 * - A committed hold is scheduled in LED once its job runs on its truck, within
 *   its dates, on as many days as were sold; Reservations stops listing a
 *   booking once all of it is.
 *
 * LED job numbers aren't unique to one program (a job can span several), and
 * placeholders like 00-0000-000 mark maintenance and internal programs, so
 * only a real job number ever links anything.
 */

import { query } from '@/lib/mssql'
import { shiftDay, shiftDayIn } from '@/lib/scheduleQuery'
import { jobKey } from '@/lib/jobNumber'
import { stateCode } from '@/lib/usStates'
import { countCalendarDays } from '@/lib/pricing/schedule'

/**
 * A hold as the LED match needs it. Dates are YYYY-MM-DD, inclusive.
 * `days_sold`: how many days were sold on this truck (see daysSold).
 */
export type JobHold = { id: string; truck_number: string; start_date: string; end_date: string; job_number: string | null; days_sold: number }

/** One LED shift of a job on a truck, by its start day. */
export type JobShift = { truck_number: string; job_number: string; shift_date: string }

/**
 * How many days LED must run a hold's job on its truck for the hold to count
 * as scheduled: the days sold on it, from its quote (`activationDays`, per
 * truck: a 6-days-a-week flight sells fewer days than its calendar span), else
 * every calendar day (bookings made in Salesforce have no quote on file).
 * A quote priced for a different span (the hold was re-dated after it) no
 * longer says what was sold on these dates, so every calendar day counts.
 * A planner hold records its own sold days (heldWorkDays: a rotating truck's
 * weekly stint works only some of its line's days), used while its dates
 * still match. Never more than the calendar span. Pure.
 */
export function daysSold(features: string | null, start: string, end: string): number {
  const span = countCalendarDays(start, end)
  if (span < 1) return -1  // end before start: nothing can match, never scheduled
  const f = parseFeatures(features)
  // What this hold itself sells, when it was written per hold (a planner stint
  // of a rotating truck) and its dates haven't moved since.
  const work = f.heldWorkDays
  if (f.heldStart === start && f.heldEnd === end && typeof work === 'number' && Number.isInteger(work) && work >= 0) return Math.min(work, span)
  // A quote priced for another span no longer says what was sold on these dates.
  if (typeof f.calendarDays === 'number' && Number.isFinite(f.calendarDays) && f.calendarDays !== span) return span
  const sold = f.activationDays
  return typeof sold === 'number' && Number.isInteger(sold) && sold > 0 ? Math.min(sold, span) : span
}

/** A hold's features JSON as an object (empty when absent or unreadable). Parsed once per hold. */
function parseFeatures(features: string | null): Record<string, unknown> {
  if (!features) return {}
  try {
    const f: unknown = JSON.parse(features)
    return f && typeof f === 'object' ? f as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * Whether an LED program's market is the hold's market, for a program on
 * another truck (the swap picker). LED's market names are typed by hand
 * ("Manhatten", or a standard market a city sits under), so this asks for the
 * same state and the same city, by LED's own name or its standard market's.
 * When it can't be confirmed the answer is no: the truck stays taken, the safe
 * side. Pure.
 */
export function ledMarketMatches(
  hold: { market: string; state: string },
  led: { market: string; state: string; standard_market_name?: string },
): boolean {
  const city = (m: string) => m.split(',')[0].trim().toLowerCase().replace(/\s+/g, ' ')
  // The state field, else what follows the comma ("Phoenix, AZ").
  const stateOf = (m: string, s: string) => stateCode(s) || stateCode(m.split(',')[1])
  const std = led.standard_market_name ?? ''
  const holdState = stateOf(hold.market, hold.state)
  const ledState = stateOf(led.market, led.state) || stateOf(std, '')
  if (!holdState || holdState !== ledState) return false
  const want = city(hold.market)
  return !!want && (want === city(led.market) || (!!std && stateOf(std, '') === holdState && want === city(std)))
}

/** How a hold stands in LED: the days its job runs on its truck within its dates, of the days sold. */
export type LedStanding = { days: number; of: number; scheduled: boolean }

/**
 * Each hold's standing in LED. A hold is scheduled only when LED runs its job
 * on its truck, within its dates, on at least as many days as were sold, so a
 * booking LED has only partly scheduled stays listed and shows the shortfall.
 * A count can't tell which weekday was meant as the day off; the hold keeps
 * blocking every day of its range either way. Pure.
 */
export function ledStandings(holds: JobHold[], shifts: JobShift[]): Map<string, LedStanding> {
  const byTruckJob = new Map<string, Set<string>>()
  for (const s of shifts) {
    const job = jobKey(s.job_number)
    if (!job) continue
    const key = `${s.truck_number}|${job}`
    const days = byTruckJob.get(key)
    if (days) days.add(s.shift_date)
    else byTruckJob.set(key, new Set([s.shift_date]))
  }
  const out = new Map<string, LedStanding>()
  for (const h of holds) {
    const job = jobKey(h.job_number)
    if (!job) continue
    const all = byTruckJob.get(`${h.truck_number}|${job}`) ?? new Set<string>()
    const days = [...all].filter(d => d >= h.start_date && d <= h.end_date).length
    // A hold that sells no days (a planner stint of only travel or idle days)
    // has nothing for LED to run, so it's scheduled; bad dates (-1) never are.
    out.set(h.id, { days, of: Math.max(h.days_sold, 0), scheduled: h.days_sold >= 0 && days >= h.days_sold })
  }
  return out
}

// Each hold's own job on its own truck within its own dates: the only shifts
// ledStandings can count. Driven by the holds (one JSON parameter, so nothing
// reaches the SQL text) through each truck's schedule, so the read grows with
// the number of holds, not with how far apart their dates are. A day with
// several shifts comes back more than once; ledStandings counts each day once.
const HOLD_SHIFTS_QUERY = `
SELECT
    t.truck_number,
    LTRIM(RTRIM(cp.job_number)) AS job_number,
    CONVERT(varchar(10), ${shiftDay('ps.start_time')}, 120) AS shift_date
FROM OPENJSON(@holds) WITH (
    truck NVARCHAR(4000) '$.truck',
    job   NVARCHAR(4000) '$.job',
    s     DATE         '$.start',
    e     DATE         '$.end'
) h
JOIN dbo.trucks t           ON t.truck_number = h.truck
JOIN dbo.program_schedule ps ON ps.truck_uid = t.truck_uid
JOIN dbo.client_programs cp ON cp.client_program_uid = ps.client_program_uid
LEFT JOIN dbo.client_program_markets cpm ON cpm.client_program_market_uid = ps.client_program_market_uid
WHERE COALESCE(cp.is_deleted, 0) = 0  -- only a live program counts as the job scheduled
  AND ${shiftDayIn({ from: 'h.s', to: 'h.e' })}
  AND LTRIM(RTRIM(cp.job_number)) = h.job  -- the LED column's collation is case-insensitive
`

/** The LED shifts of each hold's job on its truck within its dates. Reads the LED database; throws if it can't. */
export async function ledShiftsForHolds(holds: JobHold[]): Promise<JobShift[]> {
  const rows = holds.flatMap(h => {
    const job = jobKey(h.job_number)
    return job ? [{ truck: h.truck_number, job, start: h.start_date, end: h.end_date }] : []
  })
  if (!rows.length) return []
  return query<JobShift[]>(HOLD_SHIFTS_QUERY, { holds: JSON.stringify(rows) })
}

/** LED's days for a won job outside its reservation's dates: the range LED runs it, and how many days fall outside. */
export type LedOutside = { from: string; to: string; outside: number }

/**
 * The won holds whose job LED runs on days outside the reservation's dates
 * (any truck), so Reservations can say so: the truck follow (lib/ledTruckFollow.ts)
 * only sees LED within a hold's dates, and dates are never moved for a person.
 * The reservation's dates are its job's holds together, earliest start to
 * latest end. `days`: each job's LED days (YYYY-MM-DD) near those dates
 * (ledJobDays). Pure.
 */
export function ledDaysOutside(holds: JobHold[], days: { job_number: string; shift_date: string }[]): Map<string, LedOutside> {
  const span = new Map<string, { from: string; to: string }>()
  for (const h of holds) {
    const job = jobKey(h.job_number)
    if (!job) continue
    const s = span.get(job)
    span.set(job, s ? { from: h.start_date < s.from ? h.start_date : s.from, to: h.end_date > s.to ? h.end_date : s.to } : { from: h.start_date, to: h.end_date })
  }
  const daysOf = new Map<string, Set<string>>()
  for (const d of days) {
    const job = jobKey(d.job_number)
    if (!job || !span.has(job)) continue
    const set = daysOf.get(job)
    if (set) set.add(d.shift_date)
    else daysOf.set(job, new Set([d.shift_date]))
  }
  const byJob = new Map<string, LedOutside>()
  for (const [job, set] of daysOf) {
    const s = span.get(job)!
    const all = [...set].sort()
    const outside = all.filter(d => d < s.from || d > s.to).length
    if (outside) byJob.set(job, { from: all[0], to: all[all.length - 1], outside })
  }
  const out = new Map<string, LedOutside>()
  for (const h of holds) {
    const o = byJob.get(jobKey(h.job_number) ?? '')
    if (o) out.set(h.id, o)
  }
  return out
}

/** How far either side of a reservation's dates LED's days of its job are read. */
export const LED_OUTSIDE_WINDOW_DAYS = 60

// Each won job's LED days (any truck, live programs) within
// LED_OUTSIDE_WINDOW_DAYS of its reservation's dates: what ledDaysOutside
// compares. One JSON parameter, so nothing reaches the SQL text.
const JOB_DAYS_QUERY = `
SELECT DISTINCT
    LTRIM(RTRIM(cp.job_number)) AS job_number,
    CONVERT(varchar(10), ${shiftDay('ps.start_time')}, 120) AS shift_date
FROM OPENJSON(@jobs) WITH (
    job NVARCHAR(4000) '$.job',
    s   DATE         '$.start',
    e   DATE         '$.end'
) j
JOIN dbo.client_programs cp ON LTRIM(RTRIM(cp.job_number)) = j.job  -- the LED column's collation is case-insensitive
JOIN dbo.program_schedule ps ON ps.client_program_uid = cp.client_program_uid
LEFT JOIN dbo.client_program_markets cpm ON cpm.client_program_market_uid = ps.client_program_market_uid
WHERE COALESCE(cp.is_deleted, 0) = 0  -- only a live program counts
  AND ${shiftDayIn({ from: `DATEADD(day, -${LED_OUTSIDE_WINDOW_DAYS}, j.s)`, to: `DATEADD(day, ${LED_OUTSIDE_WINDOW_DAYS}, j.e)` })}
`

/** LED's days for each won job near its holds' dates (any truck). Reads the LED database; throws if it can't. */
export async function ledJobDays(holds: JobHold[]): Promise<{ job_number: string; shift_date: string }[]> {
  const span = new Map<string, { start: string; end: string }>()
  for (const h of holds) {
    const job = jobKey(h.job_number)
    if (!job) continue
    const s = span.get(job)
    span.set(job, s ? { start: h.start_date < s.start ? h.start_date : s.start, end: h.end_date > s.end ? h.end_date : s.end } : { start: h.start_date, end: h.end_date })
  }
  if (!span.size) return []
  const jobs = [...span].map(([job, s]) => ({ job, ...s }))
  return query<{ job_number: string; shift_date: string }[]>(JOB_DAYS_QUERY, { jobs: JSON.stringify(jobs) })
}

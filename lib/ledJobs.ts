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
import { jobKey } from '@/lib/jobNumber'
import { stateCode } from '@/lib/usStates'
import { activationDaysOf } from '@/lib/transportMetrics'
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
  // What this hold itself sells, when it was written per hold (a planner stint
  // of a rotating truck) and its dates haven't moved since.
  if (span < 1) return -1  // end before start: nothing can match, never scheduled
  const held = heldDays(features)
  if (held && held.start === start && held.end === end) return Math.min(held.work, span)
  const quoted = quotedSpan(features)
  if (quoted !== null && quoted !== span) return span
  const sold = activationDaysOf(features)
  return sold !== null && Number.isInteger(sold) && sold > 0 ? Math.min(sold, span) : span
}

/** The days a planner hold was written to sell (heldStart/heldEnd/heldWorkDays), or null. */
function heldDays(features: string | null): { start: string; end: string; work: number } | null {
  if (!features) return null
  try {
    const f = JSON.parse(features) as { heldStart?: unknown; heldEnd?: unknown; heldWorkDays?: unknown }
    return typeof f.heldStart === 'string' && typeof f.heldEnd === 'string' && typeof f.heldWorkDays === 'number' && Number.isInteger(f.heldWorkDays) && f.heldWorkDays >= 0
      ? { start: f.heldStart, end: f.heldEnd, work: f.heldWorkDays }
      : null
  } catch {
    return null
  }
}

/** The calendar span the quote was priced for, or null when it doesn't say. */
function quotedSpan(features: string | null): number | null {
  if (!features) return null
  try {
    const n = (JSON.parse(features) as { calendarDays?: unknown }).calendarDays
    return typeof n === 'number' && Number.isFinite(n) ? n : null
  } catch {
    return null
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
    CONVERT(varchar(10), CAST(ps.start_time AS DATE), 120) AS shift_date
FROM OPENJSON(@holds) WITH (
    truck NVARCHAR(4000) '$.truck',
    job   NVARCHAR(4000) '$.job',
    s     DATE         '$.start',
    e     DATE         '$.end'
) h
JOIN dbo.trucks t           ON t.truck_number = h.truck
JOIN dbo.program_schedule ps ON ps.truck_uid = t.truck_uid
                            AND ps.start_time >= h.s AND ps.start_time < DATEADD(day, 1, h.e)
JOIN dbo.client_programs cp ON cp.client_program_uid = ps.client_program_uid
WHERE COALESCE(cp.is_deleted, 0) = 0
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

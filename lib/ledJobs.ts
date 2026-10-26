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
import { realJobNumber } from '@/lib/jobNumber'
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
 * Never more than the calendar span. Pure.
 */
export function daysSold(features: string | null, start: string, end: string): number {
  const span = countCalendarDays(start, end)
  const quoted = quotedSpan(features)
  if (quoted !== null && quoted !== span) return span
  const sold = activationDaysOf(features)
  return sold !== null && Number.isInteger(sold) && sold > 0 ? Math.min(sold, span) : span
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
    const job = realJobNumber(s.job_number)
    if (!job) continue
    const key = `${s.truck_number}|${job}`
    const days = byTruckJob.get(key)
    if (days) days.add(s.shift_date)
    else byTruckJob.set(key, new Set([s.shift_date]))
  }
  const out = new Map<string, LedStanding>()
  for (const h of holds) {
    const job = realJobNumber(h.job_number)
    if (!job) continue
    const all = byTruckJob.get(`${h.truck_number}|${job}`) ?? new Set<string>()
    const days = [...all].filter(d => d >= h.start_date && d <= h.end_date).length
    out.set(h.id, { days, of: h.days_sold, scheduled: days > 0 && days >= h.days_sold })
  }
  return out
}

// Every LED shift of the given jobs, by truck and day, within the holds' dates
// (a hold only counts days inside its own range, so older shifts are never
// needed). The job list arrives as one JSON parameter, so it never reaches the
// SQL text. A day with several shifts comes back more than once; ledStandings
// counts each day once.
const JOB_SHIFTS_QUERY = `
SELECT
    t.truck_number,
    LTRIM(RTRIM(cp.job_number)) AS job_number,
    CONVERT(varchar(10), CAST(ps.start_time AS DATE), 120) AS shift_date
FROM dbo.program_schedule ps
JOIN dbo.trucks t           ON t.truck_uid = ps.truck_uid
JOIN dbo.client_programs cp ON cp.client_program_uid = ps.client_program_uid
WHERE COALESCE(cp.is_deleted, 0) = 0
  AND LTRIM(RTRIM(cp.job_number)) IN (SELECT value FROM OPENJSON(@jobs))
  AND ps.start_time >= CAST(@from AS DATE) AND ps.start_time < DATEADD(day, 1, CAST(@to AS DATE))
`

/** The LED shifts of these holds' jobs. Reads the LED database; throws if it can't. */
export async function ledShiftsForJobs(holds: JobHold[]): Promise<JobShift[]> {
  const jobs = [...new Set(holds.map(h => realJobNumber(h.job_number)).filter((j): j is string => !!j))]
  if (!jobs.length) return []
  const from = holds.reduce((m, h) => (h.start_date < m ? h.start_date : m), holds[0].start_date)
  const to = holds.reduce((m, h) => (h.end_date > m ? h.end_date : m), holds[0].end_date)
  return query<JobShift[]>(JOB_SHIFTS_QUERY, { jobs: JSON.stringify(jobs), from, to })
}

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
 * - A committed hold is scheduled in LED once its job runs on its truck within
 *   its dates; Reservations stops listing a booking once all of it is.
 *
 * LED job numbers aren't unique to one program (a job can span several), and
 * placeholders like 00-0000-000 mark maintenance and internal programs, so
 * only a real job number ever links anything.
 */

import { query } from '@/lib/mssql'
import { realJobNumber } from '@/lib/jobNumber'

/** A hold as the LED match needs it. Dates are YYYY-MM-DD, inclusive. */
export type JobHold = { id: string; truck_number: string; start_date: string; end_date: string; job_number: string | null }

/** One LED shift of a job on a truck, by its start day. */
export type JobShift = { truck_number: string; job_number: string; shift_date: string }

/**
 * The holds LED has scheduled: its job runs on the hold's truck on at least one
 * day of the hold. Not every day: LED schedules only the days a truck works
 * (weekday flights, days off), so requiring each day would never match. Pure.
 */
export function ledScheduledHoldIds(holds: JobHold[], shifts: JobShift[]): Set<string> {
  const byTruckJob = new Map<string, string[]>()
  for (const s of shifts) {
    const job = realJobNumber(s.job_number)
    if (!job) continue
    const key = `${s.truck_number}|${job}`
    const days = byTruckJob.get(key)
    if (days) days.push(s.shift_date)
    else byTruckJob.set(key, [s.shift_date])
  }
  const out = new Set<string>()
  for (const h of holds) {
    const job = realJobNumber(h.job_number)
    if (!job) continue
    const days = byTruckJob.get(`${h.truck_number}|${job}`) ?? []
    if (days.some(d => d >= h.start_date && d <= h.end_date)) out.add(h.id)
  }
  return out
}

// Every LED shift of the given jobs, by truck and day. The job list arrives as
// one JSON parameter, so it never reaches the SQL text.
const JOB_SHIFTS_QUERY = `
SELECT DISTINCT
    t.truck_number,
    LTRIM(RTRIM(cp.job_number)) AS job_number,
    CONVERT(varchar(10), CAST(ps.start_time AS DATE), 120) AS shift_date
FROM dbo.program_schedule ps
JOIN dbo.trucks t           ON t.truck_uid = ps.truck_uid
JOIN dbo.client_programs cp ON cp.client_program_uid = ps.client_program_uid
WHERE COALESCE(cp.is_deleted, 0) = 0
  AND LTRIM(RTRIM(cp.job_number)) IN (SELECT value FROM OPENJSON(@jobs))
`

/** The LED shifts of these holds' jobs. Reads the LED database; throws if it can't. */
export async function ledShiftsForJobs(holds: JobHold[]): Promise<JobShift[]> {
  const jobs = [...new Set(holds.map(h => realJobNumber(h.job_number)).filter((j): j is string => !!j))]
  if (!jobs.length) return []
  return query<JobShift[]>(JOB_SHIFTS_QUERY, { jobs: JSON.stringify(jobs) })
}

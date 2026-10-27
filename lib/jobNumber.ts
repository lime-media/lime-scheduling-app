import { stateCode } from '@/lib/usStates'

/**
 * A job number worth matching on, or null: blank, or a placeholder like
 * 00-0000-000 (maintenance and internal programs in LED). Pure; shared by the
 * planner and the LED match (lib/ledJobs.ts), and safe in client bundles.
 */
export function realJobNumber(v: string | null | undefined): string | null {
  const t = (v ?? '').trim()
  return t && !/^[0\-\s]+$/.test(t) ? t : null
}

/**
 * A job number as compared between Salesforce and LED: real, and case-folded,
 * since SQL Server's default collation already matches them case-insensitively.
 * Null when there's nothing to match on. Pure.
 */
export function jobKey(v: string | null | undefined): string | null {
  return realJobNumber(v)?.toUpperCase() ?? null
}

/**
 * The job number that links a hold to its LED program: only a won (COMMITTED)
 * hold's. A tentative or reopened reservation isn't the booking LED runs, so
 * a program sharing its job still occupies the truck. Pure.
 */
export function linkedJob(hold: { status: string; sfdc_job_number?: string | null }): string | null {
  return hold.status === 'COMMITTED' ? hold.sfdc_job_number ?? null : null
}

/**
 * Whether an LED program (or one day of it) is a won hold's own booking being
 * scheduled rather than something else on the truck: it carries the hold's
 * job number, overlaps the hold's dates, and isn't in another state.
 * Every market of a multi-market booking shares one job number, so a program
 * in a different state is another market of the booking, and the hold's own
 * market still has no truck there. (Same-state markets can't be told apart:
 * LED's city names are typed by hand.) `state`: this row's state; a row with
 * none is judged on job and dates. `states`: every state the job runs under
 * on the truck that day: LED can file one day under markets in two states (a
 * travel day), and the day is the hold's own if any of them is the hold's
 * state. States compared as codes ("Kansas" = "KS"), and only when known.
 * Dates YYYY-MM-DD, inclusive.
 *
 * This is an any-overlap test: it says nothing about the program's days
 * outside the hold's dates, which are other work and still occupy the truck.
 * Callers pass one day at a time, or clip to the hold's dates first. The one
 * rule behind the conflict sweep, the fleet timelines and the swap picker. Pure.
 */
export function isOwnLedProgram(
  hold: { start_date: string; end_date: string; job_number?: string | null; state?: string | null },
  program: { start: string; end: string; job_number?: string | null; state?: string | null; states?: (string | null | undefined)[] },
): boolean {
  const job = jobKey(hold.job_number)
  if (!job || jobKey(program.job_number) !== job || program.start > hold.end_date || program.end < hold.start_date) return false
  const hs = stateCode(hold.state)
  const row = stateCode(program.state)
  const day = (program.states ?? []).map(s => stateCode(s)).filter(Boolean)
  // Unknown on either side: job and dates decide.
  if (!hs || (!row && !day.length) || (program.state != null && !row)) return true
  return row === hs || day.includes(hs)
}

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
 * job number, falls within the hold's dates, and isn't in another state.
 * Every market of a multi-market booking shares one job number, so a program
 * in a different state is another market of the booking, and the hold's own
 * market still has no truck there. (Same-state markets can't be told apart:
 * LED's city names are typed by hand.) Outside the hold's dates the same job
 * is other work and still occupies the truck. The one rule behind the
 * conflict sweep, the fleet timelines and the swap picker. Dates YYYY-MM-DD,
 * inclusive; states two-letter, compared only when both are known. Pure.
 */
export function isOwnLedProgram(
  hold: { start_date: string; end_date: string; job_number?: string | null; state?: string | null },
  program: { start: string; end: string; job_number?: string | null; state?: string | null },
): boolean {
  const job = jobKey(hold.job_number)
  const hs = (hold.state ?? '').trim().toUpperCase()
  const ps = (program.state ?? '').trim().toUpperCase()
  return !!job && jobKey(program.job_number) === job && program.start <= hold.end_date && program.end >= hold.start_date
    && !(hs && ps && hs !== ps)
}

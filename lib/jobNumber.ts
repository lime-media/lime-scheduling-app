/**
 * A job number worth matching on, or null: blank, or a placeholder like
 * 00-0000-000 (maintenance and internal programs in LED). Pure; shared by the
 * planner and the LED match (lib/ledJobs.ts), and safe in client bundles.
 */
export function realJobNumber(v: string | null | undefined): string | null {
  const t = (v ?? '').trim()
  return t && !/^[0\-\s]+$/.test(t) ? t : null
}

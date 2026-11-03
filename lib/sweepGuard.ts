/**
 * Whether the maintenance sweep (app/api/cron) may run in this deployment.
 * Preview deployments (UAT) share production's Salesforce org and SMTP. Their
 * email is redirected or not sent (lib/mailRedirect.ts), and their Salesforce
 * writes are off unless someone turned them on (lib/salesforceClient.ts
 * salesforceWritesOff): the sweep refuses only then.
 */
import { salesforceWritesOff } from '@/lib/salesforceClient'

/** Why the sweep must not run in this deployment, or null. Production always runs. Pure. */
export function sweepUnsafeHere(env: Record<string, string | undefined>): string | null {
  if (env.VERCEL_ENV !== 'preview' || salesforceWritesOff(env)) return null
  return "Not sweeping a preview deployment with Salesforce writes on: it shares production's Salesforce. Remove SFDC_WRITES=on from it first."
}

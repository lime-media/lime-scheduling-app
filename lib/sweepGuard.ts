/**
 * Whether the maintenance sweep (app/api/cron) may run in this deployment.
 * Preview deployments (UAT) share production's Salesforce org and SMTP, so
 * their sweep needs Salesforce writes off and mail redirected
 * (lib/salesforceClient.ts salesforceWritesOff, lib/mailRedirect.ts).
 */

/**
 * Why the sweep must not run in this deployment, or null. Production always
 * runs; a preview (UAT) only with SFDC_WRITES=off and EMAIL_REDIRECT_TO set. Pure.
 */
export function sweepUnsafeHere(env: Record<string, string | undefined>): string | null {
  if (env.VERCEL_ENV !== 'preview') return null
  const missing = [
    env.SFDC_WRITES?.trim().toLowerCase() === 'off' ? null : 'SFDC_WRITES=off',
    env.EMAIL_REDIRECT_TO?.trim() ? null : 'EMAIL_REDIRECT_TO',
  ].filter(Boolean)
  return missing.length
    ? `Not sweeping a preview deployment: it shares production's Salesforce and email. Set ${missing.join(' and ')} on it first.`
    : null
}


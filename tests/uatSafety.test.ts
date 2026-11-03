/**
 * UAT safety switches: Salesforce writes off, mail redirected, and the sweep
 * refusing a preview deployment without them.
 *
 * Run with: npm test
 */
import { defer, eq, section } from './harness'
import { redirectedMessage } from '@/lib/mailRedirect'
import { sweepUnsafeHere } from '@/lib/sweepGuard'
import { WRITES_OFF_MESSAGE, salesforceWritesOff, writesOffResponse } from '@/lib/salesforceClient'

section('mail redirect')
const msg = { from: 'app@x', to: 'rep@lime-media.com', cc: ['ops@lime-media.com'], bcc: 'a@b', subject: 'Expiring', text: 'hi' }
const r = redirectedMessage(msg, 'uat-inbox@lime-media.com')
eq('goes only to the redirect address', [r.to, r.cc, r.bcc], ['uat-inbox@lime-media.com', undefined, undefined])
eq('the subject names who it would have gone to', r.subject, '[Redirected from rep@lime-media.com, ops@lime-media.com, a@b] Expiring')
eq('the body is untouched', r.text, 'hi')
eq('no redirect set: unchanged', redirectedMessage(msg, undefined), msg)
eq('a blank redirect is none', redirectedMessage(msg, '  '), msg)

section('the sweep on a preview deployment')
eq('production always sweeps', sweepUnsafeHere({ VERCEL_ENV: 'production' }), null)
eq('local (no VERCEL_ENV) sweeps', sweepUnsafeHere({}), null)
eq('a preview with neither switch is refused, naming both', sweepUnsafeHere({ VERCEL_ENV: 'preview' }),
  "Not sweeping a preview deployment: it shares production's Salesforce and email. Set SFDC_WRITES=off and EMAIL_REDIRECT_TO on it first.")
eq('writes off but mail not redirected: refused', sweepUnsafeHere({ VERCEL_ENV: 'preview', SFDC_WRITES: 'off' })?.endsWith('Set EMAIL_REDIRECT_TO on it first.'), true)
eq('both set: sweeps', sweepUnsafeHere({ VERCEL_ENV: 'preview', SFDC_WRITES: 'OFF', EMAIL_REDIRECT_TO: 'uat@x' }), null)

section('Salesforce writes off')
const was = process.env.SFDC_WRITES
process.env.SFDC_WRITES = 'off'
eq('read from SFDC_WRITES', salesforceWritesOff(), true)
process.env.SFDC_WRITES = was
eq('unset: writes on', salesforceWritesOff(), was?.trim().toLowerCase() === 'off')
const res = writesOffResponse()
eq('a refused write looks like a Salesforce refusal', res.status, 403)
defer(res.json().then(body => eq('with the reason', body, [{ errorCode: 'WRITES_OFF', message: WRITES_OFF_MESSAGE, fields: [] }])))

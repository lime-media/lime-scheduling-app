/**
 * UAT safety: a preview deployment never writes production's Salesforce or
 * emails real people (unless turned on), and the sweep refuses one that does.
 *
 * Run with: npm test
 */
import { defer, eq, section } from './harness'
import { mailPolicy, redirectedMessage } from '@/lib/mailRedirect'
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
eq('an address object is named by its address', redirectedMessage({ to: { name: 'Rep', address: 'rep@x' }, subject: 'S' }, 'u@x').subject, '[Redirected from rep@x] S')

section('where email goes')
eq('production: as addressed', mailPolicy({ VERCEL_ENV: 'production' }), { kind: 'send' })
eq('local: as addressed', mailPolicy({}), { kind: 'send' })
eq('a preview without a redirect: not sent', mailPolicy({ VERCEL_ENV: 'preview' }), { kind: 'drop' })
eq('a redirect set: there', mailPolicy({ VERCEL_ENV: 'preview', EMAIL_REDIRECT_TO: ' uat@x ' }), { kind: 'redirect', to: 'uat@x' })

section('the sweep on a preview deployment')
eq('production always sweeps', sweepUnsafeHere({ VERCEL_ENV: 'production' }), null)
eq('local (no VERCEL_ENV) sweeps', sweepUnsafeHere({}), null)
eq('a preview sweeps: its Salesforce writes are off by default', sweepUnsafeHere({ VERCEL_ENV: 'preview' }), null)
eq('a preview with writes turned on is refused', sweepUnsafeHere({ VERCEL_ENV: 'preview', SFDC_WRITES: 'on' }),
  "Not sweeping a preview deployment with Salesforce writes on: it shares production's Salesforce. Remove SFDC_WRITES=on from it first.")

section('Salesforce writes off')
const was = process.env.SFDC_WRITES
process.env.SFDC_WRITES = 'off'
eq('read from SFDC_WRITES', salesforceWritesOff(), true)
delete process.env.SFDC_WRITES
eq('unset: writes on', salesforceWritesOff(), false)
// Assigning undefined to process.env stores the string "undefined".
if (was === undefined) delete process.env.SFDC_WRITES
else process.env.SFDC_WRITES = was
eq('read from a given env', salesforceWritesOff({ SFDC_WRITES: ' Off ' }), true)
eq('a preview: off by default', salesforceWritesOff({ VERCEL_ENV: 'preview' }), true)
eq('a preview turned on on purpose', salesforceWritesOff({ VERCEL_ENV: 'preview', SFDC_WRITES: 'on' }), false)
eq('production: on', salesforceWritesOff({ VERCEL_ENV: 'production' }), false)
const res = writesOffResponse()
eq('a refused write looks like a Salesforce refusal', res.status, 403)
defer(res.json().then(body => eq('with the reason', body, [{ errorCode: 'WRITES_OFF', message: WRITES_OFF_MESSAGE, fields: [] }])))

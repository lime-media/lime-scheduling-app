/**
 * The login-code email body (lib/emailTemplates.ts). Run with: npm test
 */
import { eq, section } from './harness'
import { askerEmail, assistanceRequestText, otpHtml } from '@/lib/emailTemplates'

section('login code email')
{
  const html = otpHtml({ name: 'Sarah Chaudhari', code: '763931', ttlMinutes: 10 })

  eq('shows the code', html.includes('763931'), true)
  eq('greets by name', html.includes('Sarah Chaudhari'), true)
  eq('says how long it lasts', html.includes('10 minutes'), true)
  // Mail clients show the first text in the body next to the subject. Without
  // a preheader that is the greeting, which tells the reader nothing.
  eq('leads with the code in the inbox preview',
    html.indexOf('Your code is 763931') < html.indexOf('Hi Sarah'), true)
  // A remote image would be blocked by default, leaving a broken box on the
  // one email where the reader is deciding whether to trust what they see.
  eq('loads nothing from off the page', /<img|url\(|src=/.test(html), false)

  // A name comes from the client record, which ops types.
  const nasty = otpHtml({ name: '<script>alert(1)</script>', code: '000000', ttlMinutes: 5 })
  eq('a name cannot inject markup', nasty.includes('<script>alert'), false)
  eq('and is still readable once escaped', nasty.includes('&lt;script&gt;'), true)
}

section('assistance request email (F13)')
{
  const data = { clientUserId: 'c1', companyName: 'Acme', market: 'Dallas', state: 'TX', startDate: '2026-12-07', endDate: '2026-12-20', details: 'Can we add a truck?' }
  const text = assistanceRequestText(data, { username: 'pat@acme.com', email: 'pat@acme.com' })
  eq('names who asked', text.includes('From:    pat@acme.com'), true)
  eq('says Reply goes to them', text.includes('Reply to this email to answer pat@acme.com directly.'), true)
  eq('no dead login line', text.includes('led.lime-media.com'), false)
  eq('a separate email on file is shown beside the username', assistanceRequestText(data, { username: 'acme-pat', email: 'pat@acme.com' }).includes('From:    acme-pat <pat@acme.com>'), true)
  eq('no address on file: says so', assistanceRequestText(data, { username: 'acme-pat', email: null }).includes('No email address is on file'), true)
  eq('an action link when there is a page', assistanceRequestText({ ...data, actionUrl: 'https://x/hold-requests' }, null).includes('Act on it: https://x/hold-requests'), true)
  eq('askerEmail: the email on file', askerEmail({ username: 'acme-pat', email: ' pat@acme.com ' }), 'pat@acme.com')
  eq('askerEmail: else a username that is an email', askerEmail({ username: 'pat@acme.com', email: null }), 'pat@acme.com')
  eq('askerEmail: neither', askerEmail({ username: 'acme-pat', email: 'not an email' }), null)
  eq('askerEmail: a list is not one address', askerEmail({ username: 'acme-pat', email: 'x,evil@other.com' }), null)
  eq('account not read or gone: says so, not "no email on file"', assistanceRequestText(data, null).includes("Who asked isn't known"), true)
}

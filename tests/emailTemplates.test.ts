/**
 * The login-code email body (lib/emailTemplates.ts). Run with: npm test
 */
import { eq, section } from './harness'
import { otpHtml } from '@/lib/emailTemplates'

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

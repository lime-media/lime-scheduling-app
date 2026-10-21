/**
 * Client-portal login: the session token (lib/clientSessionToken.ts) and the
 * address shown on the code screen (lib/clientOtp.ts).
 *
 * The OTP rules themselves (one live code, 10-minute expiry, 5 attempts,
 * 45-second cooldown) live in lib/otp.ts and are exercised through the
 * database, so they are not covered here — this harness is pure functions.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { readSession, signSession } from '@/lib/clientSessionToken'
import { clientEmailRefusal, maskEmail } from '@/lib/clientEmail'

const SECRET = 'test-secret'
const DAY    = 86_400_000
const now    = Date.parse('2026-10-21T12:00:00Z')
const THIRTY = 60 * 60 * 24 * 30

const claims = { id: 'cu_1', username: 'firefly', companyName: 'Firefly', partnerId: 'p_9' }

section('client session: signing and reading back')
{
  const token = signSession(claims, SECRET, THIRTY, now)
  eq('round-trips the claims', readSession(token, SECRET, now), claims)
  eq('still valid at 29 days', !!readSession(token, SECRET, now + 29 * DAY), true)
  eq('still valid a minute before 30 days', !!readSession(token, SECRET, now + 30 * DAY - 60_000), true)
  eq('dead at exactly 30 days', readSession(token, SECRET, now + 30 * DAY), null)
  eq('dead after 30 days', readSession(token, SECRET, now + 31 * DAY), null)
}

section('client session: a token that is not ours is refused')
{
  const token = signSession(claims, SECRET, THIRTY, now)
  eq('another secret', readSession(token, 'other-secret', now), null)

  // Re-sign a changed payload with the wrong key: the company cannot be swapped.
  const forged = signSession({ ...claims, companyName: 'Someone Else' }, 'other-secret', THIRTY, now)
  eq('payload re-signed with the wrong key', readSession(forged, SECRET, now), null)

  const [data, sig] = token.split('.')
  const swapped = Buffer.from(JSON.stringify({ ...claims, id: 'cu_2', exp: Math.floor(now / 1000) + THIRTY })).toString('base64url')
  eq('payload swapped, signature kept', readSession(`${swapped}.${sig}`, SECRET, now), null)
  eq('signature truncated', readSession(`${data}.${sig.slice(0, -4)}`, SECRET, now), null)
  eq('no signature at all', readSession(data, SECRET, now), null)
  eq('empty', readSession('', SECRET, now), null)
  eq('not base64', readSession('!!!.???', SECRET, now), null)
}

section('client session: tokens signed before login codes')
{
  // How sessions were signed when they never ended: no exp in the payload.
  // These are refused, so every client authenticates once with a code.
  const data = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const crypto = require('crypto') as typeof import('crypto')
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url')
  eq('a correctly signed token with no exp is still refused', readSession(`${data}.${sig}`, SECRET, now), null)
}

section('client session: optional claims survive the round trip')
{
  const bare = { id: 'cu_3', username: 'reva', companyName: 'Reva' }
  const token = signSession(bare, SECRET, THIRTY, now)
  eq('a client with no partner or account id', readSession(token, SECRET, now), bare)
}

section('login code: which inbox to check')
{
  eq('keeps two letters and the domain', maskEmail('jordan@example.com'), 'jo***@example.com')
  eq('the mask is fixed, so it never says how long the address is',
    maskEmail('jo@example.com'), maskEmail('jordan-at-a-very-long-name@example.com'))
  eq('one-letter name', maskEmail('j@example.com'), 'j***@example.com')
  eq('a plus tag is hidden too', maskEmail('ops+led@example.com'), 'op***@example.com')
  eq('only the last @ counts', maskEmail('a@b@example.com'), 'a@***@example.com')
  eq('no @ gives nothing away', maskEmail('not-an-email'), '***')
  eq('empty', maskEmail(''), '***')
}

section('client users: an account with no email could not sign in, so it is refused')
{
  const ok = (e: unknown) => clientEmailRefusal(e) === null
  eq('a plain address', ok('ops@example.com'), true)
  eq('a plus tag', ok('ops+led@example.com'), true)
  eq('surrounding spaces are trimmed', ok('  ops@example.com  '), true)

  eq('blank is refused', ok(''), false)
  eq('spaces only', ok('   '), false)
  eq('missing entirely', ok(undefined), false)
  eq('null', ok(null), false)
  eq('not a string', ok(42), false)
  eq('no @', ok('ops.example.com'), false)
  eq('nothing before the @', ok('@example.com'), false)
  eq('nothing after the @', ok('ops@'), false)
  eq('two @', ok('a@b@example.com'), false)
  eq('a space inside', ok('two words@example.com'), false)

  eq('the reason says why it is needed',
    clientEmailRefusal(''), 'An email address is required: client sign-in sends a code to it.')
  eq('and quotes what was typed',
    clientEmailRefusal('nope'), '"nope" is not an email address. Client sign-in sends a code to it.')
}

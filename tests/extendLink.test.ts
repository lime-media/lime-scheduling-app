/**
 * The expiry email's Extend link (lib/extendLink.ts).
 *
 * Run with: npm test
 */
import crypto from 'crypto'
import { eq, section } from './harness'
import { addDays, isExtendDays, readExtendToken, signExtendToken } from '@/lib/extendLink'

const SECRET = 'test-secret'
const claims = { holdId: 'h1', userId: 'u1', expiresAt: '2026-10-29T04:59:00.000Z' }
const before = Date.parse('2026-10-28T12:00:00Z')
const token = signExtendToken(claims, SECRET)

section('extend link token')
eq('reads back before the expiry', readExtendToken(token, SECRET, before), claims)
eq('stops working once the warned expiry passes', readExtendToken(token, SECRET, Date.parse('2026-10-29T05:00:00Z')), null)
eq('another secret: refused', readExtendToken(token, 'other', before), null)
const [data, sig] = token.split('.')
const forged = Buffer.from(JSON.stringify({ h: 'h2', u: 'u1', e: claims.expiresAt })).toString('base64url')
eq('a changed hold: refused', readExtendToken(`${forged}.${sig}`, SECRET, before), null)
eq('a changed signature: refused', readExtendToken(`${data}.${sig.slice(0, -1)}x`, SECRET, before), null)
eq('garbage: refused', readExtendToken('nope', SECRET, before), null)
eq('a client-session token signed with the same secret is not an extend link',
  readExtendToken(`${data}.${crypto.createHmac('sha256', SECRET).update(data).digest('base64url')}`, SECRET, before), null)

section('addDays / isExtendDays')
eq('one day', addDays('2026-10-28', 1), '2026-10-29')
eq('across a month', addDays('2026-10-31', 2), '2026-11-02')
eq('across the DST change', addDays('2026-11-01', 1), '2026-11-02')
eq('1 and 2 are offered', [1, 2].map(isExtendDays), [true, true])
eq('anything else is not', [0, 3, '1', true, 1.5].map(isExtendDays), [false, false, false, false, false])

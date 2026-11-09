/**
 * The expiry email's Extend link (lib/extendLink.ts).
 *
 * Run with: npm test
 */
import crypto from 'crypto'
import { eq, section } from './harness'
import { addDays, extendOptions, isExtendDays, readCancelToken, readExtendToken, signCancelToken, signExtendToken } from '@/lib/extendLink'
import { CANCEL_REASON_MAX, cancelledOf, cleanCancelReason } from '@/lib/cancelReason'

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

section('cancel link token')
const cancelToken = signCancelToken(claims, SECRET)
eq('reads back before the expiry', readCancelToken(cancelToken, SECRET, before), claims)
eq('stops working once the warned expiry passes', readCancelToken(cancelToken, SECRET, Date.parse('2026-10-29T05:00:00Z')), null)
eq('an Extend link can\'t cancel', readCancelToken(token, SECRET, before), null)
eq('a Cancel link can\'t extend', readExtendToken(cancelToken, SECRET, before), null)
eq('Extend links already sent still work (same signing)', token.split('.')[1], crypto.createHmac('sha256', SECRET).update(`extend:${data}`).digest('base64url'))

section('cleanCancelReason')
eq('trimmed', cleanCancelReason('  client went another way  '), 'client went another way')
eq('empty or not text: none', [cleanCancelReason('   '), cleanCancelReason(undefined), cleanCancelReason(42)], [null, null, null])
eq('cut to the column', cleanCancelReason('x'.repeat(CANCEL_REASON_MAX + 5))?.length, CANCEL_REASON_MAX)

section('cancelledOf: the booking\'s latest release was a cancel')
const row = (expires_at: string, cancel_reason: string | null, status = 'EXPIRED') => ({ status, expires_at, cancelled_at: cancel_reason === null ? null : expires_at, cancel_reason })
eq('cancelled', cancelledOf([row('2026-11-09T15:00:00.000Z', 'client went elsewhere')]), { reason: 'client went elsewhere' })
eq('an ordinary lapse', cancelledOf([row('2026-11-09T15:00:00.000Z', null)]), null)
eq('a market that ended before the cancel doesn\'t change it', cancelledOf([row('2026-11-01T05:59:00.000Z', null), row('2026-11-09T15:00:00.000Z', 'x')]), { reason: 'x' })
eq('holds added later that lapse on their own: an ordinary lapse', cancelledOf([row('2026-11-09T15:00:00.000Z', 'x'), row('2026-11-20T05:59:00.000Z', null)]), null)
eq('live rows are ignored', cancelledOf([row('2026-11-09T15:00:00.000Z', 'x'), row('2026-12-01T05:59:00.000Z', null, 'HOLD')]), { reason: 'x' })

section('addDays / isExtendDays')
eq('one day', addDays('2026-10-28', 1), '2026-10-29')
eq('across a month', addDays('2026-10-31', 2), '2026-11-02')
eq('across the DST change', addDays('2026-11-01', 1), '2026-11-02')
eq('1 and 2 are offered', [1, 2].map(isExtendDays), [true, true])
eq('anything else is not', [0, 3, '1', true, 1.5].map(isExtendDays), [false, false, false, false, false])

section('extendOptions')
eq('both days within the limit', extendOptions('2026-10-28', '2026-11-05').map(o => [o.days, o.label]), [[1, 'Thu, Oct 29'], [2, 'Fri, Oct 30']])
eq('none past the limit', extendOptions('2026-10-28', '2026-10-29').map(o => o.days), [1])
eq('none that would cut short a hold of the booking expiring later', extendOptions('2026-10-28', '2026-11-05', '2026-10-30').map(o => o.days), [2])

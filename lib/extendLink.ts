/**
 * The Extend link in the expiry reminder email (lib/holdExpiryWarnings.ts):
 * a signed token that lets the rep who placed a booking extend it by a day or
 * two without signing in (app/extend, app/api/extend).
 *
 * The token names one hold of the booking, the rep, and the expiry the email
 * warned about. It stops working when that expiry passes, and once the
 * booking's expiry changes (someone already extended it), so a second click,
 * or an old email, can't extend twice. Its own module, with no Next imports,
 * so these rules are covered by tests/extendLink.test.ts.
 */
import crypto from 'crypto'

export type ExtendClaims = {
  /** A hold of the booking (any: the booking moves as one). */
  holdId: string
  /** The rep it was sent to: the hold's creator. */
  userId: string
  /** The expiry the email warned about (ISO). */
  expiresAt: string
}

/** How many days the email offers to add. */
export const EXTEND_DAYS = [1, 2] as const

const hmac = (secret: string, data: string) =>
  crypto.createHmac('sha256', secret).update(`extend:${data}`).digest('base64url')

/** Signs the claims; the token stops working at the warned expiry. */
export function signExtendToken(claims: ExtendClaims, secret: string): string {
  const data = Buffer.from(JSON.stringify({ h: claims.holdId, u: claims.userId, e: claims.expiresAt })).toString('base64url')
  return `${data}.${hmac(secret, data)}`
}

/** The claims in a token, or null if it isn't ours, was altered, or its expiry has passed. */
export function readExtendToken(token: string, secret: string, nowMs: number = Date.now()): ExtendClaims | null {
  try {
    const dot = token.lastIndexOf('.')
    if (dot < 0) return null
    const data = token.slice(0, dot)
    const sig = token.slice(dot + 1)
    const expected = hmac(secret, data)
    if (sig.length !== expected.length) return null
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
    const { h, u, e } = JSON.parse(Buffer.from(data, 'base64url').toString()) as { h?: unknown; u?: unknown; e?: unknown }
    if (typeof h !== 'string' || typeof u !== 'string' || typeof e !== 'string') return null
    const at = Date.parse(e)
    if (isNaN(at) || at <= nowMs) return null
    return { holdId: h, userId: u, expiresAt: e }
  } catch {
    return null
  }
}

/** The date (YYYY-MM-DD) `days` after `fromDate` (YYYY-MM-DD). Pure. */
export function addDays(fromDate: string, days: number): string {
  const d = new Date(fromDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The refusal once the warned expiry has moved: each email extends once. */
export const EXTEND_STALE_MESSAGE = 'This reservation has already been extended or changed. The next reminder will have a new link, or change it on Reservations.'

const SHORT_DATE = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

/**
 * The Extend choices for an expiry on `expiresOn` (YYYY-MM-DD, Central): each
 * of EXTEND_DAYS whose date stays on or before `lastDate` (the booking's
 * limit) and doesn't fall before `notBefore` (a later expiry elsewhere in the
 * booking, which extending must not cut short). The email and the confirm
 * page offer the same ones. Pure.
 */
export function extendOptions(expiresOn: string, lastDate: string, notBefore = ''): { days: number; date: string; label: string }[] {
  return EXTEND_DAYS
    .map(days => ({ days: days as number, date: addDays(expiresOn, days) }))
    .filter(o => o.date <= lastDate && o.date >= notBefore)
    .map(o => ({ ...o, label: SHORT_DATE.format(new Date(o.date + 'T00:00:00Z')) }))
}

/** Whether `days` is one the email offers. */
export function isExtendDays(days: unknown): days is (typeof EXTEND_DAYS)[number] {
  return typeof days === 'number' && (EXTEND_DAYS as readonly number[]).includes(days)
}

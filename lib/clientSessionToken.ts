/**
 * The client-portal session token: sign, and read back.
 *
 * Its own module, with no Next imports, so the rules that matter — a token
 * stops working at `exp`, a tampered one is refused, one signed before login
 * codes existed is refused — are covered by tests/clientSession.test.ts.
 * lib/clientAuth.ts puts the result in a cookie.
 */

import crypto from 'crypto'

export type ClientSessionClaims = {
  id:              string
  username:        string
  companyName:     string
  partnerId?:      string
  sfdcAccountId?:  string
}

/** What is actually signed: the claims plus when they stop counting. */
type Signed = ClientSessionClaims & {
  /** Unix seconds. A token without one predates login codes; see readSession. */
  exp?: number
}

const hmac = (secret: string, data: string) =>
  crypto.createHmac('sha256', secret).update(data).digest('base64url')

/** Signs the claims with an absolute expiry `ttlSeconds` from `nowMs`. */
export function signSession(claims: ClientSessionClaims, secret: string, ttlSeconds: number, nowMs: number = Date.now()): string {
  const payload: Signed = { ...claims, exp: Math.floor(nowMs / 1000) + ttlSeconds }
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${data}.${hmac(secret, data)}`
}

/**
 * The claims in a token, or null if it is not ours, was altered, has run out,
 * or carries no expiry at all.
 *
 * A token with no `exp` was signed when a client session never ended. Those
 * are refused rather than honoured, so everyone re-authenticates once with a
 * code — the cookie's own maxAge was only ever the client's copy of the rule.
 */
export function readSession(token: string, secret: string, nowMs: number = Date.now()): ClientSessionClaims | null {
  try {
    const dot = token.lastIndexOf('.')
    if (dot < 0) return null
    const data = token.slice(0, dot)
    const sig  = token.slice(dot + 1)
    const expected = hmac(secret, data)
    // Compare in constant time; length must match first or timingSafeEqual throws.
    if (sig.length !== expected.length) return null
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null

    const { exp, ...claims } = JSON.parse(Buffer.from(data, 'base64url').toString()) as Signed
    if (typeof exp !== 'number' || exp * 1000 <= nowMs) return null
    return claims as ClientSessionClaims
  } catch {
    return null
  }
}

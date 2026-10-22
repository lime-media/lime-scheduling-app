import { NextRequest, NextResponse } from 'next/server'
import { readSession, signSession, type ClientSessionClaims } from '@/lib/clientSessionToken'

const SECRET      = process.env.NEXTAUTH_SECRET || 'lime-client-secret'
const TOKEN_NAME  = 'client_token'
const GUEST_NAME  = 'guest_session'
/**
 * How long a client stays signed in after passing the login code. The cookie
 * says the same, but the cookie is the client's copy — `exp` inside the signed
 * payload is what actually ends the session, so a token kept after the cookie
 * expires is still refused.
 */
export const CLIENT_SESSION_DAYS = 30
const MAX_AGE     = 60 * 60 * 24 * CLIENT_SESSION_DAYS

/**
 * The signed claims. `partnerId` links to a RateAgreement.partner_id
 * (app_client_users.partner_id) — it lets the client-portal AI quote engine
 * apply this client's negotiated rate. Undefined for a session signed before
 * that field existed, or for a client with no agreement — both mean "standard
 * rate card," never an error.
 */
export type ClientSession = ClientSessionClaims

const sign   = (session: ClientSession) => signSession(session, SECRET, MAX_AGE)
const verify = (token: string) => readSession(token, SECRET)

export function getClientSession(req: NextRequest): ClientSession | null {
  const token = req.cookies.get(TOKEN_NAME)?.value
  return token ? verify(token) : null
}

export function isGuestRequest(req: NextRequest): boolean {
  return !!req.cookies.get(GUEST_NAME)?.value
}

export function setClientSession(res: NextResponse, session: ClientSession): void {
  res.cookies.set(TOKEN_NAME, sign(session), {
    httpOnly: true,
    sameSite: 'lax',
    secure:   process.env.NODE_ENV === 'production',
    path:     '/',
    maxAge:   MAX_AGE,
  })
}

export function setGuestSession(res: NextResponse): void {
  res.cookies.set(GUEST_NAME, '1', {
    httpOnly: true,
    sameSite: 'lax',
    path:     '/',
    maxAge:   60 * 60 * 24,
  })
}

export function clearClientSession(res: NextResponse): void {
  res.cookies.delete(TOKEN_NAME)
  res.cookies.delete(GUEST_NAME)
}

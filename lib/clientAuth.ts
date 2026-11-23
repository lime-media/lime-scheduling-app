import { NextRequest, NextResponse } from 'next/server'
import { readSession, signSession, type ClientSessionClaims } from '@/lib/clientSessionToken'
import { prisma } from '@/lib/prisma'

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

/** The client record fields a session carries, as stored now. */
export type ClientUserNow = { username: string; company_name: string; partner_id: string | null; sfdc_account_id: string | null }

/**
 * A signed session brought up to date with the client's record: the cookie
 * proves who is signed in; the record says, as of now, their company name,
 * Salesforce account and rate agreement. So staff relinking an account,
 * renaming a client or changing its agreement takes effect on the client's
 * next request, not their next login. A deleted client is signed out (null).
 * If the record can't be read, the signed values stand for who the client is,
 * rather than locking them out, but the session is marked (linksUnverified):
 * its account and rate agreement may be up to 30 days old, so nothing is
 * priced on them (unverifiedPricingRefusal).
 */
export function liveClientSession(claims: ClientSession, now: ClientUserNow | null | 'unreadable'): ClientSession | null {
  if (now === 'unreadable') {
    const session = { ...claims }
    unverified.add(session)
    return session
  }
  if (!now) return null
  return {
    id: claims.id,
    username: now.username,
    companyName: now.company_name,
    partnerId: now.partner_id ?? undefined,
    sfdcAccountId: now.sfdc_account_id ?? undefined,
  }
}

// Sessions whose record couldn't be read this request: kept apart from the
// claims, so the mark can never be signed into a cookie.
const unverified = new WeakSet<ClientSession>()

/** The record couldn't be read: the session's account and rate agreement are the login-time copies. */
export function linksUnverified(session: ClientSession): boolean {
  return unverified.has(session)
}

/**
 * The refusal for anything that prices a client while their record can't be
 * read (linksUnverified): a quote or booking priced off a rate agreement
 * staff may have changed since login is worse than asking to retry. Null
 * when the session is live.
 */
export function unverifiedPricingRefusal(session: ClientSession): { status: number; body: { error: string } } | null {
  return linksUnverified(session)
    ? { status: 503, body: { error: "We couldn't confirm your account's pricing just now. Please try again in a moment." } }
    : null
}

/**
 * Whether the request carries a valid signed client session, from the cookie
 * alone: no database read. For routes that only need to know someone is
 * signed in (the market typeahead, read per keystroke), not who they are now.
 */
export function hasClientCookie(req: NextRequest): boolean {
  const token = req.cookies.get(TOKEN_NAME)?.value
  return !!token && !!verify(token)
}

// One read per request: the usage log and the handler both ask.
const perRequest = new WeakMap<NextRequest, Promise<ClientSession | null>>()

/**
 * The signed-in client, as their record stands now (liveClientSession), or
 * null. Read once per request and shared by every caller of that request, so
 * the usage log and the handler agree and the row is read once.
 */
export function getClientSession(req: NextRequest): Promise<ClientSession | null> {
  const have = perRequest.get(req)
  if (have) return have
  const p = readClientSession(req)
  perRequest.set(req, p)
  return p
}

async function readClientSession(req: NextRequest): Promise<ClientSession | null> {
  const token = req.cookies.get(TOKEN_NAME)?.value
  const claims = token ? verify(token) : null
  if (!claims) return null
  let now: ClientUserNow | null | 'unreadable'
  try {
    now = await prisma.clientUser.findUnique({
      where: { id: claims.id },
      select: { username: true, company_name: true, partner_id: true, sfdc_account_id: true },
    })
  } catch (err) {
    console.error('[clientAuth] client record read failed; using the signed session:', err)
    now = 'unreadable'
  }
  return liveClientSession(claims, now)
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

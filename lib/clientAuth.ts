import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'

const SECRET      = process.env.NEXTAUTH_SECRET || 'lime-client-secret'
const TOKEN_NAME  = 'client_token'
const GUEST_NAME  = 'guest_session'
const MAX_AGE     = 60 * 60 * 24 * 7 // 7 days

export interface ClientSession {
  id:          string
  username:    string
  companyName: string
}

function sign(payload: ClientSession): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig  = crypto.createHmac('sha256', SECRET).update(data).digest('base64url')
  return `${data}.${sig}`
}

function verify(token: string): ClientSession | null {
  try {
    const dot = token.lastIndexOf('.')
    if (dot < 0) return null
    const data = token.slice(0, dot)
    const sig  = token.slice(dot + 1)
    const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url')
    if (sig !== expected) return null
    return JSON.parse(Buffer.from(data, 'base64url').toString()) as ClientSession
  } catch {
    return null
  }
}

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

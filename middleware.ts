import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'

// Paths that never need auth
const ALWAYS_PUBLIC = [
  '/login',
  '/client/login',
  '/api/auth',
  '/api/client',
  '/api/v1/internal',
  '/_next',
  '/favicon.ico',
  '/logo.png',
]

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (ALWAYS_PUBLIC.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next()
  }

  // Client-facing pages — require client_token or guest_session cookie
  if (pathname.startsWith('/client')) {
    const hasToken = !!req.cookies.get('client_token')?.value
    const hasGuest = !!req.cookies.get('guest_session')?.value
    if (!hasToken && !hasGuest) {
      return NextResponse.redirect(new URL('/client/login', req.url))
    }
    return NextResponse.next()
  }

  // Internal pages — require NextAuth JWT
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logo.png).*)'],
}

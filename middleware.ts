import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export default withAuth(
  function middleware(req: NextRequest) {
    // On mobile devices: redirect / to /ai unless ?from=nav is present
    if (req.nextUrl.pathname === '/') {
      const ua = req.headers.get('user-agent') || ''
      const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua)
      const fromNav = req.nextUrl.searchParams.has('from')

      if (isMobile && !fromNav) {
        return NextResponse.redirect(new URL('/ai', req.url))
      }
    }
  },
  {
    callbacks: {
      authorized: ({ token }) => !!token,
    },
  }
)

export const config = {
  matcher: ['/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)'],
}

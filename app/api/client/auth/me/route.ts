import { NextRequest, NextResponse } from 'next/server'
import { getClientSession } from '@/lib/clientAuth'

export async function GET(req: NextRequest) {
  const session = getClientSession(req)
  if (session) return NextResponse.json({ user: session })

  const res = NextResponse.json({ user: null })
  // The cookie is there but the session in it has run out (30 days) or was
  // signed before login codes existed. Drop it, so the middleware's presence
  // check stops passing and the next page load goes to the login screen
  // instead of showing a signed-out portal with no explanation.
  // A guest has no client_token, so guest browsing is untouched.
  if (req.cookies.get('client_token')?.value) {
    res.cookies.delete('client_token')
  }
  return res
}

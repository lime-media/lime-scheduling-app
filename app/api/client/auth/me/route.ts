import { NextRequest, NextResponse } from 'next/server'
import { getClientSession } from '@/lib/clientAuth'

/**
 * Reads the client session cookie, so it can never be statically prerendered.
 *
 * Declared explicitly because without it Next attempts a static render at build
 * time, hits request.cookies, and throws DYNAMIC_SERVER_USAGE to bail out — which
 * these routes' own try/catch then swallows and logs as a query failure. The
 * route still ends up dynamic, but the build log fills with errors that are not
 * errors, and a genuine fault looks exactly the same.
 */
export const dynamic = 'force-dynamic'


export async function GET(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ user: null })
  return NextResponse.json({ user: session })
}

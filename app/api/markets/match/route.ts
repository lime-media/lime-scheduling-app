/**
 * GET /api/markets/match?q=<market text>[&state=<code>]
 *
 * The same match as /api/v1/internal/markets/match (lib/marketMatch.ts), for
 * signed-in staff screens. Any signed-in staff user.
 */
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { matchMarketText } from '@/lib/marketMatch'
import { readMatchQuery } from '@/lib/marketMatchQuery'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const q = readMatchQuery(new URL(request.url).searchParams)
  if ('error' in q) return NextResponse.json({ error: q.error }, { status: 400 })
  try {
    return NextResponse.json(await matchMarketText(q.text, q.state))
  } catch (err) {
    console.error('[markets/match] market list unavailable:', err)
    return NextResponse.json({ error: "The market list couldn't be read. Try again shortly." }, { status: 503 })
  }
}

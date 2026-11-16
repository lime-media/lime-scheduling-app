/**
 * GET /api/v1/internal/markets/match?q=<market text>[&state=<code>]
 *
 * The market list entry for any market text (lib/marketMatch.ts), for the MCP
 * server and other systems, so every endpoint matches markets the same way.
 * `obvious`: default to `choice`; otherwise pick from `candidates`.
 * Internal API key.
 */
import { NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { matchMarketText } from '@/lib/marketMatch'
import { readMatchQuery } from '@/lib/marketMatchQuery'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const authError = validateInternalApiKey(request)
  if (authError) return authError
  const q = readMatchQuery(new URL(request.url).searchParams)
  if ('error' in q) return NextResponse.json({ error: q.error }, { status: 400 })
  try {
    return NextResponse.json(await matchMarketText(q.text, q.state))
  } catch (err) {
    console.error('[markets/match] market list unavailable:', err)
    return NextResponse.json({ error: "The market list couldn't be read. Try again shortly." }, { status: 503 })
  }
}

/**
 * A client's multi-market quote, from the client portal. The quote itself is
 * lib/clientMultiMarket.ts.
 */

import { withUsageLog } from '@/lib/usageLog'
import { NextRequest, NextResponse } from 'next/server'
import { getClientSession } from '@/lib/clientAuth'
import { clientMultiMarketQuote } from '@/lib/clientMultiMarket'

export const maxDuration = 300

async function handlePost(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const result = await clientMultiMarketQuote(session, body)
  return NextResponse.json(result.body, { status: result.status })
}

// Every run is logged for the Usage page (lib/usageLog.ts).
export const POST = withUsageLog('quote_client_multi', 'client', handlePost)

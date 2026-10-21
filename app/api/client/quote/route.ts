/**
 * Direct quote API for the client portal. The quote itself is
 * lib/clientQuote.ts.
 */

import { withUsageLog } from '@/lib/usageLog'
import { NextRequest, NextResponse } from 'next/server'
import { getClientSession } from '@/lib/clientAuth'
import { clientQuote, type ClientQuoteInput } from '@/lib/clientQuote'

async function handlePost(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: ClientQuoteInput

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const result = await clientQuote(session, body)
  return NextResponse.json(result.body, { status: result.status })
}

// Every run is logged for the Usage page (lib/usageLog.ts).
export const POST = withUsageLog('quote_client', 'client', handlePost)

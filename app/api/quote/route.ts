/**
 * Internal quote API — same pricing logic as the client-facing
 * POST /api/client/quote, but authenticated via NextAuth (internal staff)
 * and accepts a sfdc_account_id for Salesforce opportunity creation.
 *
 * This endpoint is used by the internal /quote page. The quote itself is
 * lib/staffQuote.ts, shared with the staff AI chat.
 */

import { withUsageLog } from '@/lib/usageLog'
import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { staffQuote, type StaffQuoteInput } from '@/lib/staffQuote'

async function handlePost(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: StaffQuoteInput
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const result = await staffQuote(body)
  return NextResponse.json(result.body, { status: result.status })
}

// Every run is logged for the Usage page (lib/usageLog.ts).
export const POST = withUsageLog('quote_classic', 'staff', handlePost)

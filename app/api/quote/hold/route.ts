/**
 * POST /api/quote/hold
 *
 * Internal hold placement — staff creates a hold on behalf of a client.
 * Requires a sfdc_account_id to create the Salesforce Opportunity.
 * Uses the availability engine to auto-select trucks. The booking itself is
 * lib/staffBooking.ts, shared with the staff AI chat.
 */

import { withUsageLog } from '@/lib/usageLog'
import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { placeStaffBooking } from '@/lib/staffBooking'

async function handlePost(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const result = await placeStaffBooking(body, {
    id: token.id as string | undefined,
    name: token.name as string | undefined,
    email: token.email as string | undefined,
  })
  return NextResponse.json(result.body, { status: result.status })
}

// Every run is logged for the Usage page (lib/usageLog.ts).
export const POST = withUsageLog('hold_classic', 'staff', handlePost)

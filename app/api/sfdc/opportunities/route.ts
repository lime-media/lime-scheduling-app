import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { isSfdcConfigured } from '@/lib/salesforceClient'
import { listOpenLedOpportunities } from '@/lib/sfdcBooking'

/**
 * GET /api/sfdc/opportunities?accountId=001…
 *
 * The account's open LED opportunities, newest first: what a quote can be
 * added to instead of starting a new one. Staff only.
 */
export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isSfdcConfigured()) return NextResponse.json({ opportunities: [] })
  const accountId = req.nextUrl.searchParams.get('accountId')?.trim() ?? ''
  try {
    return NextResponse.json({ opportunities: await listOpenLedOpportunities(accountId) })
  } catch (err) {
    console.error('[sfdc/opportunities] failed:', err)
    return NextResponse.json({ error: 'Could not load opportunities' }, { status: 500 })
  }
}

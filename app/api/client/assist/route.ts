import { NextRequest, NextResponse } from 'next/server'
import { getClientSession } from '@/lib/clientAuth'
import { sendAssistanceRequestEmail } from '@/lib/email'

/**
 * POST /api/client/assist
 *
 * Sends an assistance request email to the Lime Media team on behalf of
 * the logged-in client. Used when the self-service quote flow can't fulfill
 * the request (e.g. insufficient truck availability).
 */
export async function POST(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { market, state, start_date, end_date, details } = await req.json()
  if (!details) {
    return NextResponse.json({ error: 'details is required' }, { status: 400 })
  }

  try {
    await sendAssistanceRequestEmail({
      companyName: session.companyName,
      market,
      state,
      startDate: start_date,
      endDate: end_date,
      details,
    })
  } catch (err) {
    console.error('[client/assist] email failed:', err)
    return NextResponse.json({ error: 'Failed to send request' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

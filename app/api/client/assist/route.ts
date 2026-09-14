import { NextRequest, NextResponse } from 'next/server'
import { getClientSession } from '@/lib/clientAuth'
import { sendAssistanceRequestEmail } from '@/lib/email'

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

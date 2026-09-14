import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
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
 * POST /api/client/hold-requests/[id]/extend
 *
 * Client requests an extension on a hold with a specific date.
 * The hold's status flips to EXTENSION_REQUESTED, the requested date and
 * reason are stored, and a notification email goes to the team.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { reason, extend_until } = await req.json().catch(() => ({ reason: '', extend_until: '' }))

  if (!extend_until) {
    return NextResponse.json({ error: 'extend_until date is required' }, { status: 400 })
  }

  const extendDate = new Date(extend_until + 'T23:59:59Z')
  if (isNaN(extendDate.getTime())) {
    return NextResponse.json({ error: 'Invalid extend_until date' }, { status: 400 })
  }

  if (extendDate <= new Date()) {
    return NextResponse.json({ error: 'Extension date must be in the future' }, { status: 400 })
  }

  const hold = await prisma.hold.findUnique({ where: { id } })
  if (!hold || hold.client_user_id !== session.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (hold.status === 'EXPIRED') {
    return NextResponse.json({ error: 'Cannot extend an expired hold' }, { status: 400 })
  }

  if (hold.status === 'EXTENSION_REQUESTED') {
    return NextResponse.json({ error: 'Extension already requested' }, { status: 400 })
  }

  await prisma.hold.update({
    where: { id },
    data: {
      status: 'EXTENSION_REQUESTED',
      extension_reason: reason || null,
      extension_until: extendDate,
    },
  })

  const formattedDate = extendDate.toISOString().split('T')[0]

  await sendAssistanceRequestEmail({
    companyName: session.companyName,
    market:      hold.market,
    state:       hold.state ?? undefined,
    startDate:   hold.start_date.toISOString().split('T')[0],
    endDate:     hold.end_date.toISOString().split('T')[0],
    details:     `Hold extension requested for Truck ${hold.truck_number}. Extend until: ${formattedDate}.${reason ? ` Reason: ${reason}` : ''}`,
  }).catch((e) => console.error('[hold-extend] email failed:', e))

  return NextResponse.json({ ok: true })
}

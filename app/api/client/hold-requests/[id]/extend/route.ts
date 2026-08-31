import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getClientSession } from '@/lib/clientAuth'
import { sendAssistanceRequestEmail } from '@/lib/email'

/**
 * POST /api/client/hold-requests/[id]/extend
 *
 * Client requests an extension on a hold request with a specific date.
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

  // Must be in the future
  if (extendDate <= new Date()) {
    return NextResponse.json({ error: 'Extension date must be in the future' }, { status: 400 })
  }

  const holdRequest = await prisma.holdRequest.findUnique({ where: { id } })
  if (!holdRequest || holdRequest.client_user_id !== session.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (holdRequest.status === 'REJECTED') {
    return NextResponse.json({ error: 'Cannot extend a rejected hold request' }, { status: 400 })
  }

  if (holdRequest.status === 'EXTENSION_REQUESTED') {
    return NextResponse.json({ error: 'Extension already requested' }, { status: 400 })
  }

  await prisma.holdRequest.update({
    where: { id },
    data: {
      status: 'EXTENSION_REQUESTED',
      extension_reason: reason || null,
      extension_until: extendDate,
    },
  })

  const formattedDate = extendDate.toISOString().split('T')[0]

  // Notify the team
  await sendAssistanceRequestEmail({
    companyName: session.companyName,
    market:      holdRequest.market,
    state:       holdRequest.state ?? undefined,
    startDate:   holdRequest.start_date.toISOString().split('T')[0],
    endDate:     holdRequest.end_date.toISOString().split('T')[0],
    details:     `Hold extension requested for Truck ${holdRequest.truck_number}. Extend until: ${formattedDate}.${reason ? ` Reason: ${reason}` : ''}`,
  }).catch((e) => console.error('[hold-extend] email failed:', e))

  return NextResponse.json({ ok: true })
}

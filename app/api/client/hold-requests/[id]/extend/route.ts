import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getClientSession } from '@/lib/clientAuth'
import { sendAssistanceRequestEmail } from '@/lib/email'

/**
 * POST /api/client/hold-requests/[id]/extend
 *
 * Client requests an extension on a hold request. The hold's status flips to
 * EXTENSION_REQUESTED and a notification email goes to the team. Staff can then
 * approve by updating expires_at and resetting status back to APPROVED/PENDING.
 *
 * Allowed on PENDING, APPROVED, and EXPIRED holds — a client can request
 * extension even after expiry (the team decides whether to grant it).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { reason } = await req.json().catch(() => ({ reason: '' }))

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
    },
  })

  // Notify the team
  await sendAssistanceRequestEmail({
    companyName: session.companyName,
    market:      holdRequest.market,
    state:       holdRequest.state ?? undefined,
    startDate:   holdRequest.start_date.toISOString().split('T')[0],
    endDate:     holdRequest.end_date.toISOString().split('T')[0],
    details:     `Hold extension requested for Truck ${holdRequest.truck_number}. ${reason ? `Reason: ${reason}` : 'No reason provided.'}`,
  }).catch((e) => console.error('[hold-extend] email failed:', e))

  return NextResponse.json({ ok: true })
}

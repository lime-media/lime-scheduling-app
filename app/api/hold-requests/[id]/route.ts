import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { computeHoldExpiresAt } from '@/lib/holdRequestService'

type Action = 'approve' | 'reject' | 'approve_extension' | 'deny_extension'

// Which statuses each action is valid from — mirrors the client-side gating (e.g. extension can
// only be requested from PENDING/APPROVED/EXPIRED) so staff can't, say, approve an already-
// rejected request or grant an extension nobody asked for.
const VALID_FROM: Record<Action, string[]> = {
  approve:            ['PENDING'],
  reject:             ['PENDING', 'EXTENSION_REQUESTED'],
  approve_extension:  ['EXTENSION_REQUESTED'],
  deny_extension:     ['EXTENSION_REQUESTED'],
}

/**
 * PATCH /api/hold-requests/[id]
 *
 * Staff-only review actions on a client's HoldRequest — the counterpart to the client-facing
 * submit (lib/holdRequestService.ts) and extend-request (app/api/client/hold-requests/[id]/
 * extend/route.ts) endpoints. Body: { action: 'approve' | 'reject' | 'approve_extension' |
 * 'deny_extension' }.
 *
 * - approve: creates the matching confirmed Hold (app_holds — same table the internal AI
 *   assistant's PLACE_HOLD action and the Schedule Grid write to), after checking for a
 *   truck/date conflict exactly like that action does. Status → APPROVED.
 * - reject: status → REJECTED. No Hold is created.
 * - approve_extension: grants a fresh review window via the same computeHoldExpiresAt() rule
 *   used at submission (72h from now, capped by the campaign's start date) and returns the
 *   request to PENDING for a normal approve/reject decision.
 * - deny_extension: status → EXPIRED. The request's expires_at is already in the past (that's
 *   why an extension was requested) — this just makes that explicit immediately, rather than
 *   waiting for the next hourly expireHoldRequests() sweep to do the same thing.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { action } = (await req.json().catch(() => ({}))) as { action?: Action }
  if (!action || !(action in VALID_FROM)) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }

  const holdRequest = await prisma.holdRequest.findUnique({
    where:   { id: params.id },
    include: { client_user: { select: { company_name: true } } },
  })
  if (!holdRequest) return NextResponse.json({ error: 'Hold request not found' }, { status: 404 })

  if (!VALID_FROM[action].includes(holdRequest.status)) {
    return NextResponse.json(
      { error: `Cannot ${action.replace('_', ' ')} a request with status ${holdRequest.status}` },
      { status: 400 }
    )
  }

  if (action === 'approve') {
    // Same conflict check the internal AI assistant's PLACE_HOLD action runs — a hold can't be
    // approved onto a truck/date range something else already occupies.
    const conflicts = await prisma.hold.findMany({
      where: {
        truck_number: holdRequest.truck_number,
        status:       { not: 'EXPIRED' },
        start_date:   { lte: holdRequest.end_date },
        end_date:     { gte: holdRequest.start_date },
      },
    })
    if (conflicts.length > 0) {
      const c = conflicts[0]
      return NextResponse.json({
        error: `Truck ${holdRequest.truck_number} already has a ${c.status} for "${c.client_name}" ` +
               `from ${c.start_date.toISOString().split('T')[0]} to ${c.end_date.toISOString().split('T')[0]}.`,
      }, { status: 409 })
    }

    const hold = await prisma.hold.create({
      data: {
        truck_number: holdRequest.truck_number,
        client_name:  holdRequest.client_user.company_name,
        market:       holdRequest.market,
        state:        holdRequest.state ?? '',
        start_date:   holdRequest.start_date,
        end_date:     holdRequest.end_date,
        status:       'HOLD',
        source:       'CLIENT',
        origination:  'client-portal',
        notes:        holdRequest.notes,
        created_by:   session.user.id,
      },
    })

    await prisma.holdRequest.update({ where: { id: holdRequest.id }, data: { status: 'APPROVED' } })

    await prisma.auditLog.create({
      data: {
        action:       'APPROVE_HOLD_REQUEST',
        truck_number: holdRequest.truck_number,
        user_id:      session.user.id,
        hold_id:      hold.id,
        details:      JSON.stringify({
          hold_request_id: holdRequest.id,
          company_name:    holdRequest.client_user.company_name,
          pricing_tier:    holdRequest.pricing_tier,
          quoted_total:    holdRequest.quoted_total,
        }),
      },
    })

    return NextResponse.json({ ok: true, status: 'APPROVED', hold_id: hold.id })
  }

  if (action === 'reject') {
    await prisma.holdRequest.update({ where: { id: holdRequest.id }, data: { status: 'REJECTED' } })
    await prisma.auditLog.create({
      data: {
        action:       'REJECT_HOLD_REQUEST',
        truck_number: holdRequest.truck_number,
        user_id:      session.user.id,
        details:      JSON.stringify({ hold_request_id: holdRequest.id, company_name: holdRequest.client_user.company_name }),
      },
    })
    return NextResponse.json({ ok: true, status: 'REJECTED' })
  }

  if (action === 'approve_extension') {
    // Use the client's requested extension date if provided, otherwise fall back
    // to the standard 72h SLA recalculation.
    const newExpiresAt = holdRequest.extension_until
      ? holdRequest.extension_until
      : computeHoldExpiresAt(holdRequest.start_date.toISOString().split('T')[0])
    await prisma.holdRequest.update({
      where: { id: holdRequest.id },
      data:  { status: 'PENDING', expires_at: newExpiresAt, extension_until: null, extension_reason: null },
    })
    await prisma.auditLog.create({
      data: {
        action:       'APPROVE_HOLD_REQUEST_EXTENSION',
        truck_number: holdRequest.truck_number,
        user_id:      session.user.id,
        details:      JSON.stringify({ hold_request_id: holdRequest.id, new_expires_at: newExpiresAt.toISOString() }),
      },
    })
    return NextResponse.json({ ok: true, status: 'PENDING', expires_at: newExpiresAt.toISOString() })
  }

  // deny_extension
  await prisma.holdRequest.update({ where: { id: holdRequest.id }, data: { status: 'EXPIRED' } })
  await prisma.auditLog.create({
    data: {
      action:       'DENY_HOLD_REQUEST_EXTENSION',
      truck_number: holdRequest.truck_number,
      user_id:      session.user.id,
      details:      JSON.stringify({ hold_request_id: holdRequest.id }),
    },
  })
  return NextResponse.json({ ok: true, status: 'EXPIRED' })
}

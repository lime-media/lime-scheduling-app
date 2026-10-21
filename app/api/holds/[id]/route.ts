import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere } from '@/lib/holdFilters'
import { CLOSED_WON_READ_ONLY, closedWonRefusal } from '@/lib/bookings'
import { getOpportunityStage } from '@/lib/sfdcOpportunityReconcile'
import { recordSwap, recordWon } from '@/lib/transportMetricsRecord'
import { waitUntil } from '@vercel/functions'

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const hold = await prisma.hold.findUnique({ where: { id: params.id } })
  if (!hold) {
    return NextResponse.json({ error: 'Hold not found' }, { status: 404 })
  }

  // Sales can only edit their own holds
  if (session.user.role === 'SALES' && hold.created_by !== session.user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { status, notes, start_date, end_date, client_name, market, state, truck_number } = body

  // Only Salesforce commits a hold. Committed means Closed Won (lib/bookings.ts
  // closedWonRefusal), and the reconcile un-commits it if the deal leaves Closed
  // Won; a hold committed here on an open deal, or with no deal, would be locked
  // with nothing in Salesforce to change (#120 review). So committing checks the
  // live stage, and an unknown stage refuses rather than guesses.
  let wonStage: Awaited<ReturnType<typeof getOpportunityStage>> = null
  if (status === 'COMMITTED' && hold.status !== 'COMMITTED') {
    const stage = hold.sfdc_opportunity_id ? await getOpportunityStage(hold.sfdc_opportunity_id) : null
    wonStage = stage
    if (!stage?.isClosed || !stage.isWon) {
      return NextResponse.json({
        error: hold.sfdc_opportunity_id
          ? 'A reservation is committed when its opportunity is Closed Won in Salesforce. Mark it Closed Won there; the app commits it within 15 minutes.'
          : 'A reservation is committed when its Salesforce opportunity is Closed Won, and this one has no opportunity.',
      }, { status: 409 })
    }
  }

  // A committed hold is a Closed Won deal: read-only here except a truck swap
  // (logistics; the deal is unchanged) and a note (lib/bookings.ts closedWonRefusal).
  if (closedWonRefusal([hold])) {
    const changes = Object.keys(body).filter(k => body[k] !== undefined && !(k === 'status' && body[k] === 'COMMITTED'))
    if (changes.some(k => k !== 'truck_number' && k !== 'notes')) {
      return NextResponse.json({ error: CLOSED_WON_READ_ONLY }, { status: 409 })
    }
  }

  // If swapping trucks, check for conflicts on the new truck
  if (truck_number && truck_number !== hold.truck_number) {
    const effectiveStart = start_date ? new Date(start_date) : hold.start_date
    const effectiveEnd = end_date ? new Date(end_date) : hold.end_date
    const conflicts = await prisma.hold.findMany({
      where: {
        truck_number,
        id: { not: hold.id },
        ...activeHoldWhere(),
        start_date: { lte: effectiveEnd },
        end_date: { gte: effectiveStart },
      },
    })
    if (conflicts.length > 0) {
      const c = conflicts[0]
      return NextResponse.json({
        error: `Truck ${truck_number} already has a ${c.status} for "${c.client_name}" ` +
               `from ${c.start_date.toISOString().split('T')[0]} to ${c.end_date.toISOString().split('T')[0]}.`,
      }, { status: 409 })
    }
  }

  const updated = await prisma.hold.update({
    where: { id: params.id },
    data: {
      ...(status && { status }),
      // Committed is booked, not held: no expiry left to show or sweep.
      ...(status === 'COMMITTED' && { expires_at: null, extension_until: null, extension_reason: null }),
      ...(notes !== undefined && { notes }),
      ...(start_date && { start_date: new Date(start_date) }),
      ...(end_date && { end_date: new Date(end_date) }),
      ...(client_name && { client_name }),
      ...(market && { market }),
      ...(state && { state }),
      ...(truck_number && { truck_number }),
    },
  })

  await prisma.auditLog.create({
    data: {
      action: 'UPDATE_HOLD',
      truck_number: hold.truck_number,
      user_id: session.user.id,
      hold_id: hold.id,
      details: JSON.stringify(body),
    },
  })
  // Committed here, the reconcile never sees the transition: record the won
  // Amount now, unless another hold of the opportunity was already committed.
  if (wonStage && hold.sfdc_opportunity_id) {
    const opportunityId = hold.sfdc_opportunity_id
    const alreadyWon = await prisma.hold.count({ where: { sfdc_opportunity_id: opportunityId, status: 'COMMITTED', id: { not: hold.id } } })
    if (!alreadyWon) waitUntil(recordWon({ opportunityId, amount: wonStage.amount, stageName: wonStage.stageName, clientName: hold.client_name }))
  }
  // A truck swapped onto the hold: a SWAPPED transport leg (best-effort, after the response).
  if (truck_number && truck_number !== hold.truck_number) waitUntil(recordSwap(hold.id, session.user.id))

  return NextResponse.json(updated)
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const hold = await prisma.hold.findUnique({ where: { id: params.id } })
  if (!hold) {
    return NextResponse.json({ error: 'Hold not found' }, { status: 404 })
  }

  // Sales can only delete their own holds
  if (session.user.role === 'SALES' && hold.created_by !== session.user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // A won deal is never deleted here (lib/bookings.ts closedWonRefusal).
  if (closedWonRefusal([hold])) {
    return NextResponse.json({ error: CLOSED_WON_READ_ONLY }, { status: 409 })
  }

  await prisma.auditLog.create({
    data: {
      action: 'DELETE_HOLD',
      truck_number: hold.truck_number,
      user_id: session.user.id,
      hold_id: hold.id,
      details: JSON.stringify({ client_name: hold.client_name, status: hold.status }),
    },
  })

  await prisma.hold.delete({ where: { id: params.id } })

  return NextResponse.json({ success: true })
}

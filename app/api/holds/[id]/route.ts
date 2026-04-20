import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

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
  const { status, notes, start_date, end_date, client_name, market, state } = body

  const updated = await prisma.hold.update({
    where: { id: params.id },
    data: {
      ...(status && { status }),
      ...(notes !== undefined && { notes }),
      ...(start_date && { start_date: new Date(start_date) }),
      ...(end_date && { end_date: new Date(end_date) }),
      ...(client_name && { client_name }),
      ...(market && { market }),
      ...(state && { state }),
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

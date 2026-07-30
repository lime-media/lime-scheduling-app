import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { createHold } from '@/lib/holdService'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const holds = await prisma.hold.findMany({
    include: { user: { select: { name: true, email: true } } },
    orderBy: { created_at: 'desc' },
  })

  return NextResponse.json(holds)
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { truck_number, market, state, client_name, start_date, end_date, status, notes } = body

  if (!truck_number || !market || !state || !client_name || !start_date || !end_date) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const result = await createHold({
    truck_number, market, state, client_name,
    start_date, end_date, status, notes,
    created_by: session.user.id,
    origination: 'frontend',
  })

  if (!result.success) {
    return NextResponse.json({ error: result.error.message }, { status: 409 })
  }

  return NextResponse.json(result.hold, { status: 201 })
}

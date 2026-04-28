import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { query } from '@/lib/mssql'

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

  // Check for conflicts with existing holds on same truck + date range.
  // ATT_SOFT holds are soft placeholders — they don't block regular hold creation.
  const conflictingHolds = await prisma.hold.findMany({
    where: {
      truck_number,
      status: { not: 'ATT_SOFT' },
      OR: [{ start_date: { lte: new Date(end_date) }, end_date: { gte: new Date(start_date) } }],
    },
  })

  if (conflictingHolds.length > 0) {
    return NextResponse.json(
      { error: 'Conflict: truck already has a hold in this date range' },
      { status: 409 }
    )
  }

  // Block hold placement if the truck already has a LED schedule in this date range
  try {
    const schedConflict = await query<{ program: string }[]>(`
      SELECT TOP 1 cp.program
      FROM dbo.program_schedule ps
      JOIN dbo.trucks          t  ON t.truck_uid          = ps.truck_uid
      JOIN dbo.client_programs cp ON cp.client_program_uid = ps.client_program_uid
      WHERE t.truck_number                   = @truck_number
        AND CAST(ps.end_time   AS DATE) >= CAST(@start_date AS DATE)
        AND CAST(ps.start_time AS DATE) <= CAST(@end_date   AS DATE)
        AND COALESCE(t.is_deleted, 0) = 0
    `, { truck_number, start_date, end_date })

    if (schedConflict.length > 0) {
      return NextResponse.json(
        { error: `Cannot place hold — Truck ${truck_number} is already scheduled for "${schedConflict[0].program}" on these dates` },
        { status: 409 }
      )
    }
  } catch (err) {
    // If the schedule check fails, log but don't block hold creation
    console.error('[holds POST] schedule conflict check failed:', err)
  }

  const hold = await prisma.hold.create({
    data: {
      truck_number,
      market,
      state,
      client_name,
      start_date: new Date(start_date),
      end_date: new Date(end_date),
      status: status || 'HOLD',
      notes,
      created_by: session.user.id,
    },
  })

  await prisma.auditLog.create({
    data: {
      action: 'CREATE_HOLD',
      truck_number,
      user_id: session.user.id,
      hold_id: hold.id,
      details: JSON.stringify({ client_name, market, state, start_date, end_date, status }),
    },
  })

  return NextResponse.json(hold, { status: 201 })
}

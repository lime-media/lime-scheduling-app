import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { query } from '@/lib/mssql'

export async function POST() {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Next full calendar month
  const today          = new Date()
  const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1)
  const nextMonthEnd   = new Date(today.getFullYear(), today.getMonth() + 2, 0)
  const monthLabel     = nextMonthStart.toLocaleString('default', { month: 'long', year: 'numeric' })

  // Find trucks with "ATT" in any active or upcoming program name
  let attTrucks: { truck_number: string }[] = []
  try {
    attTrucks = await query<{ truck_number: string }[]>(`
      SELECT DISTINCT t.truck_number
      FROM dbo.program_schedule ps
      JOIN dbo.trucks          t  ON t.truck_uid          = ps.truck_uid
      JOIN dbo.client_programs cp ON cp.client_program_uid = ps.client_program_uid
      WHERE UPPER(cp.program) LIKE '%ATT%'
        AND COALESCE(t.is_deleted, 0) = 0
        AND CAST(ps.end_time AS DATE) >= CAST(GETDATE() AS DATE)
    `)
  } catch (err) {
    console.error('[att-sync] query failed:', err)
    return NextResponse.json({ error: 'Failed to query ATT trucks' }, { status: 500 })
  }

  let created = 0
  let skipped = 0

  for (const { truck_number } of attTrucks) {
    // Skip if an ATT_SOFT hold already covers any part of next month
    const existing = await prisma.hold.findFirst({
      where: {
        truck_number,
        status:     'ATT_SOFT',
        start_date: { lte: nextMonthEnd },
        end_date:   { gte: nextMonthStart },
      },
    })

    if (existing) {
      skipped++
      continue
    }

    await prisma.hold.create({
      data: {
        truck_number,
        status:      'ATT_SOFT',
        client_name: 'AT&T',
        market:      '',
        state:       '',
        notes:       `Auto soft hold – AT&T program – ${monthLabel}`,
        start_date:  nextMonthStart,
        end_date:    nextMonthEnd,
        created_by:  session.user.id,
      },
    })
    created++
  }

  console.log(`[att-sync] month=${monthLabel} trucks=${attTrucks.length} created=${created} skipped=${skipped}`)
  return NextResponse.json({ created, skipped, total: attTrucks.length })
}

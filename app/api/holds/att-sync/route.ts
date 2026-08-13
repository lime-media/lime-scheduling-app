import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { query } from '@/lib/mssql'
import { releaseAttSoftHolds } from '@/lib/scheduleCache'

// Local calendar-date string (not toISOString, which is UTC and can shift the
// day depending on server timezone) — matches how nextMonthStart/End below are
// built from local Date components.
function toDateOnlyStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

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

  // Release any ATT_SOFT holds superseded by a non-ATT shift since the last sync
  let released = 0
  try {
    released = await releaseAttSoftHolds()
  } catch (err) {
    console.error('[att-sync] release check failed:', err)
  }

  // Find trucks whose most recent previous shift was an ATT program, and that
  // have no shift at all scheduled for next month. "Most recent" is relative
  // to the start of next month, not real-world today — a shift dated the last
  // day of this month (e.g. Jul 31, dated after the sync happens to run) still
  // counts as the truck's most recent known shift. Date comparisons use only
  // ps.start_time — ps.end_time bleeds into the next calendar day for overnight
  // shifts (see CHAT_SCHEDULE_WINDOW_QUERY), so it's unsafe for date filtering.
  let attTrucks: { truck_number: string }[] = []
  try {
    attTrucks = await query<{ truck_number: string }[]>(
      `
      WITH most_recent_shift AS (
        SELECT
          t.truck_number,
          cp.program,
          ROW_NUMBER() OVER (PARTITION BY t.truck_number ORDER BY ps.start_time DESC) AS rn
        FROM dbo.program_schedule ps
        JOIN dbo.trucks          t  ON t.truck_uid          = ps.truck_uid
        JOIN dbo.client_programs cp ON cp.client_program_uid = ps.client_program_uid
        WHERE COALESCE(t.is_deleted, 0) = 0
          AND CAST(ps.start_time AS DATE) < @nextMonthStart
      )
      SELECT truck_number
      FROM most_recent_shift
      WHERE rn = 1
        AND UPPER(LTRIM(RTRIM(program))) LIKE 'ATT%'
        AND truck_number NOT IN (
          SELECT DISTINCT t2.truck_number
          FROM dbo.program_schedule ps2
          JOIN dbo.trucks t2 ON t2.truck_uid = ps2.truck_uid
          WHERE CAST(ps2.start_time AS DATE) BETWEEN @nextMonthStart AND @nextMonthEnd
        )
      `,
      { nextMonthStart: toDateOnlyStr(nextMonthStart), nextMonthEnd: toDateOnlyStr(nextMonthEnd) }
    )
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

  console.log(`[att-sync] month=${monthLabel} trucks=${attTrucks.length} created=${created} skipped=${skipped} released=${released}`)
  return NextResponse.json({ created, skipped, released, total: attTrucks.length })
}

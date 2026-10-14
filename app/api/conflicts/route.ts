import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getPool } from '@/lib/mssql'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const pool   = await getPool()
    // One row per reservation × LED-program block, over a date range
    // (lib/scheduleCache.ts mergeScheduleBlocks), with the reservation's own
    // dates and origin so the page can say what overlaps what.
    const result = await pool.request().query(`
      SELECT
        c.id, c.hold_id, c.truck_number,
        CONVERT(varchar(10), c.conflict_start, 120) AS conflict_start,
        CONVERT(varchar(10), c.conflict_end,   120) AS conflict_end,
        c.hold_client, c.hold_market, c.scheduled_program,
        c.status,
        CONVERT(varchar(30), c.detected_at, 127) AS detected_at,
        CONVERT(varchar(10), h.start_date, 120) AS hold_start,
        CONVERT(varchar(10), h.end_date,   120) AS hold_end,
        h.status AS hold_status, h.source AS hold_source
      FROM dbo.schedule_conflicts c
      LEFT JOIN dbo.app_holds h ON h.id = c.hold_id
      WHERE c.status = 'ACTIVE'
      ORDER BY c.detected_at DESC
    `)
    return NextResponse.json({ conflicts: result.recordset })
  } catch (error) {
    console.error('[/api/conflicts] query failed:', error)
    return NextResponse.json({ conflicts: [] })
  }
}

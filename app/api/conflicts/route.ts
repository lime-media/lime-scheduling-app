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
    const result = await pool.request().query(`
      SELECT
        id, hold_id, truck_number,
        CONVERT(varchar(10), conflict_start, 120) AS conflict_start,
        CONVERT(varchar(10), conflict_end,   120) AS conflict_end,
        hold_client, hold_market, scheduled_program,
        status,
        CONVERT(varchar(30), detected_at, 127) AS detected_at
      FROM dbo.schedule_conflicts
      WHERE status = 'ACTIVE'
      ORDER BY detected_at DESC
    `)
    return NextResponse.json({ conflicts: result.recordset })
  } catch (error) {
    console.error('[/api/conflicts] query failed:', error)
    return NextResponse.json({ conflicts: [] })
  }
}

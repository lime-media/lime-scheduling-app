import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { query } from '@/lib/mssql'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const trucks = await query(`
    SELECT truck_number, samsara_id
    FROM dbo.trucks
    WHERE is_deleted = 0 OR is_deleted IS NULL
    ORDER BY truck_number
  `)

  return NextResponse.json(trucks)
}

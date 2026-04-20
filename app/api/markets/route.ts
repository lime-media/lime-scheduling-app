import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getPool } from '@/lib/mssql'
import { getLiveVehicleLocations } from '@/lib/samsaraService'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  console.log('[/api/markets] fetching...')

  const pool = await getPool()

  // ── Scheduled markets (LED schedule only) ────────────────────────────────
  let markets: string[] = []
  try {
    const marketsResult = await pool.request().query(`
      SELECT DISTINCT LTRIM(RTRIM(market)) AS market
      FROM dbo.client_program_markets
      WHERE market IS NOT NULL AND LEN(LTRIM(RTRIM(market))) > 0
      ORDER BY market
    `)
    markets = marketsResult.recordset
      .map((r: { market: string }) => r.market?.trim())
      .filter((m: string) => m && m.length > 1)
      .sort()
  } catch (err) {
    console.error('[/api/markets] scheduled markets query failed:', err)
  }

  // ── States (from live Samsara GPS locations) ──────────────────────────────
  let states: string[] = []
  try {
    const gpsMap = await getLiveVehicleLocations()
    const stateSet = new Set<string>()
    gpsMap.forEach((v) => { if (v.state && v.state.length === 2) stateSet.add(v.state) })
    states = Array.from(stateSet).sort()
  } catch (err) {
    console.error('[/api/markets] Samsara states fetch failed:', err)
  }

  console.log('[/api/markets] markets:', markets.length, 'states:', states.length)

  return NextResponse.json({ markets, states })
}

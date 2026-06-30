import { NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { SCHEDULED_QUERY, ALL_TRUCKS_QUERY } from '@/lib/scheduleQuery'
import { getLiveVehicleLocations } from '@/lib/samsaraService'

const HIDDEN_TRUCKS = new Set(['0001', '0002', '1257', '00001257', '7333', '1991'])

function normalizeMarket(m: unknown): string {
  return String(m ?? '').replace(/\s*,\s*/g, ', ').trim()
}

function toDateStr(val: unknown): string {
  if (!val) return ''
  if (val instanceof Date) return val.toISOString().split('T')[0]
  const s = String(val)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  try { return new Date(s).toISOString().split('T')[0] } catch { return '' }
}

export async function GET(request: Request) {
  const authError = validateInternalApiKey(request)
  if (authError) return authError

  try {
    const now = new Date()

    const [trucksRaw, schedulesRaw, holds] = await Promise.all([
      query<Record<string, unknown>[]>(ALL_TRUCKS_QUERY),
      query<Record<string, unknown>[]>(SCHEDULED_QUERY),
      prisma.hold.findMany({ orderBy: { start_date: 'asc' } }),
    ])

    let gpsMap = new Map<string, { city: string; state: string }>()
    try {
      gpsMap = await getLiveVehicleLocations()
    } catch {
      // Continue without GPS — projected_market will fall back to schedule/hold data
    }

    // Build projected market per truck: schedule → hold → GPS (same logic as /api/schedule)
    const todayStr = now.toISOString().split('T')[0]
    const scheduleInfo: Record<string, { market: string; shift_start: string }> = {}
    for (const row of schedulesRaw) {
      const num = String(row.truck_number ?? '')
      const shiftStart = toDateStr(row.shift_start)
      if (shiftStart > todayStr) continue
      const existing = scheduleInfo[num]
      if (!existing || shiftStart > existing.shift_start) {
        scheduleInfo[num] = {
          market: normalizeMarket(row.standard_market_name) || normalizeMarket(row.market),
          shift_start: shiftStart,
        }
      }
    }

    const holdMarkets: Record<string, string> = {}
    for (const h of holds) {
      if (!holdMarkets[h.truck_number]) {
        holdMarkets[h.truck_number] = h.market
      }
    }

    const trucks = trucksRaw
      .filter((r) => !HIDDEN_TRUCKS.has(String(r.truck_number ?? '')))
      .map((r) => {
        const num = String(r.truck_number ?? '')
        const gpsData = gpsMap.get(num)
        const projectedMarket =
          scheduleInfo[num]?.market ||
          holdMarkets[num] ||
          (gpsData?.city ? [gpsData.city, gpsData.state].filter(Boolean).join(', ') : null)

        return {
          unit_id: num,
          projected_market: projectedMarket,
          projected_as_of: now.toISOString(),
          is_active: true,
        }
      })

    return NextResponse.json({
      trucks,
      generated_at: now.toISOString(),
    })
  } catch (error) {
    console.error('[v1/internal/inventory] Error:', error)
    return NextResponse.json({ error: 'Failed to fetch inventory' }, { status: 500 })
  }
}

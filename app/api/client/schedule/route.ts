import { NextResponse } from 'next/server'
import { query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { SCHEDULED_QUERY, ALL_TRUCKS_QUERY } from '@/lib/scheduleQuery'
import { getLiveVehicleLocations } from '@/lib/samsaraService'

let sqlCache: { trucks: unknown; schedules: unknown; timestamp: number } | null = null
const CACHE_TTL = 5 * 60 * 1000

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

const HIDDEN_TRUCKS = new Set(['0001'])

export async function GET() {
  try {
    const holdsPromise = prisma.hold.findMany({ orderBy: { start_date: 'asc' } })

    let trucksRaw: Record<string, unknown>[]
    let schedulesRaw: Record<string, unknown>[]

    if (sqlCache && Date.now() - sqlCache.timestamp < CACHE_TTL) {
      trucksRaw    = sqlCache.trucks    as Record<string, unknown>[]
      schedulesRaw = sqlCache.schedules as Record<string, unknown>[]
    } else {
      ;[trucksRaw, schedulesRaw] = await Promise.all([
        query<Record<string, unknown>[]>(ALL_TRUCKS_QUERY),
        query<Record<string, unknown>[]>(SCHEDULED_QUERY),
      ])
      sqlCache = { trucks: trucksRaw, schedules: schedulesRaw, timestamp: Date.now() }
    }

    const holds = await holdsPromise

    let gpsMap = new Map<string, { city: string; state: string; formatted_address: string }>()
    try {
      gpsMap = await getLiveVehicleLocations()
    } catch { /* continue without GPS */ }

    const todayStr = new Date().toISOString().split('T')[0]
    const scheduleInfo: Record<string, { market: string; state: string; shift_start: string }> = {}
    for (const row of schedulesRaw) {
      const num        = String(row.truck_number ?? '')
      const shiftStart = toDateStr(row.shift_start)
      if (shiftStart > todayStr) continue
      const existing   = scheduleInfo[num]
      if (!existing || shiftStart > existing.shift_start) {
        scheduleInfo[num] = {
          market:      normalizeMarket(row.standard_market_name) || normalizeMarket(row.market),
          state:       String(row.state ?? ''),
          shift_start: shiftStart,
        }
      }
    }

    const holdMarkets: Record<string, { market: string; state: string }> = {}
    for (const h of holds) {
      if (!holdMarkets[h.truck_number]) {
        holdMarkets[h.truck_number] = { market: h.market, state: h.state ?? '' }
      }
    }

    const trucks = trucksRaw
      .filter((r) => !HIDDEN_TRUCKS.has(String(r.truck_number ?? '')))
      .map((r) => {
        const num     = String(r.truck_number ?? '')
        const gpsData = gpsMap.get(num)
        return {
          truck_number:      num,
          last_gps:          gpsData?.formatted_address || null,
          last_gps_city:     gpsData?.city              || null,
          last_gps_state:    gpsData?.state             || null,
          last_known_market: scheduleInfo[num]?.market || holdMarkets[num]?.market || (gpsData?.city ? [gpsData.city, gpsData.state].filter(Boolean).join(', ') : null),
          last_known_state:  scheduleInfo[num]?.state  || holdMarkets[num]?.state  || gpsData?.state || null,
        }
      })

    const schedules = schedulesRaw
      .filter((r) => !HIDDEN_TRUCKS.has(String(r.truck_number ?? '')))
      .map((r) => ({
        truck_number:         String(r.truck_number ?? ''),
        market:               normalizeMarket(r.market),
        standard_market_name: normalizeMarket(r.standard_market_name) || undefined,
        state:                String(r.state   ?? ''),
        program:              String(r.program ?? ''),
        shift_start:          toDateStr(r.shift_start),
        shift_end:            toDateStr(r.shift_end),
      }))

    // Strip all client-identifying fields — only availability info is returned
    const holdBlocks = holds
      .filter((h) => !HIDDEN_TRUCKS.has(h.truck_number))
      .map((h) => ({
        id:           h.id,
        truck_number: h.truck_number,
        client_name:  '',
        market:       h.market,
        state:        h.state ?? '',
        notes:        '',
        start_date:   h.start_date.toISOString().split('T')[0],
        end_date:     h.end_date.toISOString().split('T')[0],
        status:       h.status as 'HOLD' | 'COMMITTED' | 'ATT_SOFT',
        created_by:   '',
        user_name:    null,
      }))

    return NextResponse.json({ trucks, schedules, holds: holdBlocks })
  } catch (error) {
    console.error('Client schedule query error:', error)
    return NextResponse.json({ error: 'Failed to fetch schedule' }, { status: 500 })
  }
}

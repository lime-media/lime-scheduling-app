import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { SCHEDULED_QUERY, ALL_TRUCKS_QUERY } from '@/lib/scheduleQuery'
import { getLiveVehicleLocations } from '@/lib/samsaraService'

// Cache Azure SQL results for 5 min; holds + GPS always fetched fresh.
let sqlCache: { trucks: unknown; schedules: unknown; timestamp: number } | null = null
const CACHE_TTL = 5 * 60 * 1000

// Normalize market names — collapse whitespace around commas (e.g. "Tallahassee , FL" → "Tallahassee, FL")
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
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const forceRefresh = searchParams.get('force') === '1'

  try {
    const holdsPromise = prisma.hold.findMany({
      include: { user: { select: { name: true } } },
      orderBy: { start_date: 'asc' },
    })

    let trucksRaw: Record<string, unknown>[]
    let schedulesRaw: Record<string, unknown>[]

    if (!forceRefresh && sqlCache && Date.now() - sqlCache.timestamp < CACHE_TTL) {
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

    // GPS map: live from Samsara API — always fresh, not cached
    let gpsMap = new Map<string, { city: string; state: string; formatted_address: string }>()
    try {
      gpsMap = await getLiveVehicleLocations()
      console.log('[schedule] Samsara GPS loaded:', gpsMap.size, 'trucks')
    } catch (e) {
      console.warn('[schedule] Samsara GPS failed, continuing without GPS:', (e as Error).message)
    }

    // Schedule market/state per truck: most recent block (no date constraint) — fallback when no GPS.
    // Use standard_market_name when available so grouping shows standardised names.
    const scheduleInfo: Record<string, { market: string; state: string; shift_start: string }> = {}
    for (const row of schedulesRaw) {
      const num        = String(row.truck_number ?? '')
      const shiftStart = toDateStr(row.shift_start)
      const existing   = scheduleInfo[num]
      if (!existing || shiftStart > existing.shift_start) {
        scheduleInfo[num] = {
          market:      normalizeMarket(row.standard_market_name) || normalizeMarket(row.market),
          state:       String(row.state  ?? ''),
          shift_start: shiftStart,
        }
      }
    }

    // Hold market/state per truck: first hold in the ordered result (start_date asc) — fallback when no GPS or schedule
    const holdMarkets: Record<string, { market: string; state: string }> = {}
    for (const h of holds) {
      if (!holdMarkets[h.truck_number]) {
        holdMarkets[h.truck_number] = { market: h.market, state: h.state ?? '' }
      }
    }

    // trucks: last_known_market = schedule market || hold market || GPS city
    //         last_known_state  = schedule state  || hold state  || GPS state
    const trucks = trucksRaw.map((r) => {
      const num     = String(r.truck_number ?? '')
      const gpsData = gpsMap.get(num)
      return {
        truck_number:      num,
        last_gps:          gpsData?.formatted_address || null,
        last_gps_city:     gpsData?.city              || null,
        last_gps_state:    gpsData?.state             || null,
        last_known_market: scheduleInfo[num]?.market  || holdMarkets[num]?.market || gpsData?.city  || null,
        last_known_state:  scheduleInfo[num]?.state   || holdMarkets[num]?.state  || gpsData?.state || null,
      }
    })

    // Debug: log first row to verify standard_market_name is populated in DB
    if (schedulesRaw.length > 0) {
      const s = schedulesRaw[0]
      console.log('[schedule] first row - market:', s.market, '| standard_market_name:', s.standard_market_name)
    }

    // schedules: { truck_number, market, state, program, shift_start, shift_end }
    const schedules = schedulesRaw.map((r) => ({
      truck_number:        String(r.truck_number        ?? ''),
      market:              normalizeMarket(r.market),
      standard_market_name: normalizeMarket(r.standard_market_name) || undefined,
      state:               String(r.state               ?? ''),
      program:             String(r.program             ?? ''),
      shift_start:         toDateStr(r.shift_start),
      shift_end:           toDateStr(r.shift_end),
    }))

    const holdBlocks = holds.map((h) => ({
      id:           h.id,
      truck_number: h.truck_number,
      client_name:  h.client_name,
      market:       h.market,
      state:        h.state ?? '',
      notes:        h.notes ?? '',
      start_date:   h.start_date.toISOString().split('T')[0],
      end_date:     h.end_date.toISOString().split('T')[0],
      status:       h.status as 'HOLD' | 'COMMITTED' | 'ATT_SOFT',
      created_by:   h.created_by,
      user_name:    h.user?.name ?? null,
    }))

    return NextResponse.json({ trucks, schedules, holds: holdBlocks })
  } catch (error) {
    console.error('Schedule query error:', error)
    return NextResponse.json({ error: 'Failed to fetch schedule' }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { getLiveVehicleLocations } from '@/lib/samsaraService'
import { query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { SCHEDULED_QUERY } from '@/lib/scheduleQuery'
import type { TruckLocation } from '@/app/api/trucks/locations/route'

function toDateStr(val: unknown): string {
  if (!val) return ''
  if (val instanceof Date) return val.toISOString().split('T')[0]
  const s = String(val)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  try { return new Date(s).toISOString().split('T')[0] } catch { return '' }
}

const HIDDEN_TRUCKS = new Set(['0001', '1257', '00001257'])

export async function GET() {
  try {
    const today = new Date().toISOString().split('T')[0]
    const now   = new Date()

    const [gpsMap, schedulesRaw, holds] = await Promise.all([
      getLiveVehicleLocations().catch(() => new Map()),
      query<Record<string, unknown>[]>(SCHEDULED_QUERY).catch(() => []),
      prisma.hold.findMany({
        where: { start_date: { lte: now }, end_date: { gte: now } },
        orderBy: { created_at: 'desc' },
      }),
    ])

    const todaySchedule = new Map<string, { market: string }>()
    for (const row of schedulesRaw) {
      const num        = String(row.truck_number ?? '')
      const shiftStart = toDateStr(row.shift_start)
      const shiftEnd   = toDateStr(row.shift_end)
      if (shiftStart <= today && shiftEnd >= today && !todaySchedule.has(num)) {
        todaySchedule.set(num, { market: String(row.market ?? '') })
      }
    }

    const holdsMap = new Map<string, typeof holds[0]>()
    for (const h of holds) {
      if (!holdsMap.has(h.truck_number)) holdsMap.set(h.truck_number, h)
    }

    const trucks: TruckLocation[] = []

    for (const [truck_number, gps] of gpsMap) {
      if (HIDDEN_TRUCKS.has(truck_number)) continue
      const sched = todaySchedule.get(truck_number)
      const hold  = holdsMap.get(truck_number)

      let status: TruckLocation['status'] = 'EMPTY'
      let market:        string | null = null
      let hold_end_date: string | null = null

      if (sched) {
        status = 'SCHEDULED_LED'
        market = sched.market || null
      } else if (hold) {
        // Map all hold types to HOLD — don't expose Committed/ATT distinction to public
        status        = 'HOLD'
        market        = hold.market
        hold_end_date = hold.end_date.toISOString().split('T')[0]
      }

      trucks.push({
        truck_number,
        latitude:          gps.latitude,
        longitude:         gps.longitude,
        formatted_address: gps.formatted_address,
        city:              gps.city,
        state:             gps.state,
        last_updated:      gps.time,
        status,
        program:       null,
        market,
        client:        null,
        hold_end_date,
      })
    }

    trucks.sort((a, b) => a.truck_number.localeCompare(b.truck_number))
    return NextResponse.json({ trucks })
  } catch (error) {
    console.error('Client map query error:', error)
    return NextResponse.json({ error: 'Failed to fetch locations' }, { status: 500 })
  }
}

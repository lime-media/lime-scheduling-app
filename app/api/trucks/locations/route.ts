import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getLiveVehicleLocations } from '@/lib/samsaraService'
import { query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { SCHEDULED_QUERY } from '@/lib/scheduleQuery'

export interface TruckLocation {
  truck_number:      string
  latitude:          number
  longitude:         number
  formatted_address: string
  city:              string
  state:             string
  last_updated:      string
  status:            'SCHEDULED_LED' | 'HOLD' | 'COMMITTED' | 'EMPTY'
  program:           string | null
  market:            string | null
  client:            string | null
  hold_end_date:     string | null
}

function toDateStr(val: unknown): string {
  if (!val) return ''
  if (val instanceof Date) return val.toISOString().split('T')[0]
  const s = String(val)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  try { return new Date(s).toISOString().split('T')[0] } catch { return '' }
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const today = new Date().toISOString().split('T')[0]
  const now   = new Date()

  const [gpsMap, schedulesRaw, holds] = await Promise.all([
    getLiveVehicleLocations().catch(() => new Map()),
    query<Record<string, unknown>[]>(SCHEDULED_QUERY).catch(() => []),
    prisma.hold.findMany({
      where: {
        start_date: { lte: now },
        end_date:   { gte: now },
      },
      orderBy: { created_at: 'desc' },
    }),
  ])

  // Today's schedule: truck_number → { program, market }
  const todaySchedule = new Map<string, { program: string; market: string }>()
  for (const row of schedulesRaw) {
    const num        = String(row.truck_number ?? '')
    const shiftStart = toDateStr(row.shift_start)
    const shiftEnd   = toDateStr(row.shift_end)
    if (shiftStart <= today && shiftEnd >= today && !todaySchedule.has(num)) {
      todaySchedule.set(num, {
        program: String(row.program ?? ''),
        market:  String(row.market  ?? ''),
      })
    }
  }

  // Active holds: truck_number → first hold (most recent)
  const holdsMap = new Map<string, typeof holds[0]>()
  for (const h of holds) {
    if (!holdsMap.has(h.truck_number)) holdsMap.set(h.truck_number, h)
  }

  const trucks: TruckLocation[] = []

  for (const [truck_number, gps] of gpsMap) {
    const sched = todaySchedule.get(truck_number)
    const hold  = holdsMap.get(truck_number)

    let status: TruckLocation['status'] = 'EMPTY'
    let program:       string | null = null
    let market:        string | null = null
    let client:        string | null = null
    let hold_end_date: string | null = null

    if (sched) {
      status  = 'SCHEDULED_LED'
      program = sched.program || null
      market  = sched.market  || null
    } else if (hold) {
      status        = hold.status as 'HOLD' | 'COMMITTED'
      client        = hold.client_name
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
      program,
      market,
      client,
      hold_end_date,
    })
  }

  trucks.sort((a, b) => a.truck_number.localeCompare(b.truck_number))

  return NextResponse.json({ trucks })
}

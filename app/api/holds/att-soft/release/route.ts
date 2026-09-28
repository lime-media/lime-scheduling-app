/**
 * POST /api/holds/att-soft/release — release a truck's AT&T soft hold for the
 * dates of a specific booking (see lib/attSoftRelease.ts). Any signed-in
 * internal user; the page shows ATT_RELEASE_WARNING first. Never exposed to
 * the partner/MCP API or the client portal.
 */

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { releaseAttSoftForBooking } from '@/lib/attSoftRelease'

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { truck_number?: string; start_date?: string; end_date?: string; context?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const { truck_number, start_date, end_date } = body
  if (!truck_number || !start_date || !end_date) {
    return NextResponse.json({ error: 'truck_number, start_date and end_date are required' }, { status: 400 })
  }
  const context = String(body.context ?? 'a booking').slice(0, 200)

  try {
    const r = await releaseAttSoftForBooking({
      truckNumber: truck_number, start: start_date, end: end_date,
      userId: session.user.id, userName: session.user.name, context,
    })
    if (r.released.length === 0) {
      return NextResponse.json({ ok: true, released: [], message: `Truck ${truck_number} has no AT&T soft hold on those dates.` })
    }
    return NextResponse.json({
      ok: true, ...r,
      message: `Released truck ${truck_number}'s AT&T soft hold for ${start_date === end_date ? start_date : `${start_date} to ${end_date}`}. The rest stays reserved for AT&T.`,
    })
  } catch (err) {
    console.error('[att-soft/release] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Release failed' }, { status: 400 })
  }
}

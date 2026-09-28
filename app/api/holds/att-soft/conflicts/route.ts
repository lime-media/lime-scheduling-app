/**
 * AT&T soft holds that still clash with a reservation — for the Conflicts
 * review page. A clash is a live reservation (hold, committed, extension
 * requested) on the same truck on any of the soft hold's dates, e.g. one
 * pushed from Salesforce. Normal per-day yielding to another client's LED
 * shift is not a clash and is not listed.
 *
 * GET  — the clashes not yet dismissed.
 * POST — { softHoldId, reservationId }: dismiss one ("not concerned"). The
 *        dismissal is an audit-log entry, so who dismissed what stays on record.
 */

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere } from '@/lib/holdFilters'

const DISMISS = 'DISMISS_ATT_SOFT_CONFLICT'
const iso = (d: Date) => d.toISOString().slice(0, 10)

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const today = new Date(); today.setUTCHours(0, 0, 0, 0)
  const soft = await prisma.hold.findMany({ where: { status: 'ATT_SOFT', end_date: { gte: today } } })
  if (soft.length === 0) return NextResponse.json({ conflicts: [] })
  const trucks = [...new Set(soft.map(h => h.truck_number))]
  const reservations = await prisma.hold.findMany({
    where: { truck_number: { in: trucks }, ...activeHoldWhere({ excludeAttSoft: true }), end_date: { gte: today } },
    include: { user: { select: { name: true } } },
  })
  const dismissed = new Set(
    (await prisma.auditLog.findMany({ where: { action: DISMISS }, select: { details: true } }))
      .map(a => { try { return (JSON.parse(a.details ?? '{}') as { key?: string }).key ?? '' } catch { return '' } }),
  )

  const conflicts = []
  for (const s of soft) {
    for (const r of reservations) {
      if (r.truck_number !== s.truck_number || r.start_date > s.end_date || r.end_date < s.start_date) continue
      const key = `${s.id}|${r.id}`
      if (dismissed.has(key)) continue
      const from = r.start_date > s.start_date ? r.start_date : s.start_date
      const to = r.end_date < s.end_date ? r.end_date : s.end_date
      conflicts.push({
        key,
        softHoldId: s.id,
        reservationId: r.id,
        truckNumber: s.truck_number,
        softHold: { start: iso(s.start_date), end: iso(s.end_date) },
        reservation: {
          start: iso(r.start_date), end: iso(r.end_date), status: r.status, source: r.source,
          client: r.client_name, market: r.market, createdBy: r.user?.name ?? null,
        },
        overlap: { start: iso(from), end: iso(to) },
      })
    }
  }
  conflicts.sort((a, b) => a.overlap.start.localeCompare(b.overlap.start) || a.truckNumber.localeCompare(b.truckNumber))
  return NextResponse.json({ conflicts })
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { softHoldId?: string; reservationId?: string }
  if (!body.softHoldId || !body.reservationId) return NextResponse.json({ error: 'softHoldId and reservationId are required' }, { status: 400 })
  const soft = await prisma.hold.findUnique({ where: { id: body.softHoldId }, select: { truck_number: true, status: true } })
  if (!soft || soft.status !== 'ATT_SOFT') return NextResponse.json({ error: 'That soft hold no longer exists.' }, { status: 404 })
  await prisma.auditLog.create({
    data: {
      action: DISMISS,
      truck_number: soft.truck_number,
      user_id: session.user.id,
      // Ids live in details, not hold_id: the soft hold is later deleted (released,
      // expired) and the audit row must never stand in the way of that.
      details: JSON.stringify({ key: `${body.softHoldId}|${body.reservationId}`, soft_hold_id: body.softHoldId, reservation_id: body.reservationId }),
    },
  })
  return NextResponse.json({ ok: true })
}

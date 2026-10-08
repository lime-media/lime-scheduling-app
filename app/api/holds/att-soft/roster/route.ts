/**
 * Manual changes to the AT&T truck list (app_att_roster_overrides).
 *
 * GET    /api/holds/att-soft/roster — changes still in effect.
 * POST   /api/holds/att-soft/roster — add a truck to the list, or take one
 *        off, for a date range: { truck_number, action: 'ADD'|'REMOVE',
 *        start_date, end_date, reason }. After end_date the automatic
 *        160over90 rule applies again.
 * DELETE /api/holds/att-soft/roster?id=… — undo a change.
 *
 * Any signed-in internal user. Every change is audit-logged, and the soft-hold
 * sync runs straight away so the list shows the result. Never exposed to the
 * partner/MCP API or the client portal.
 */

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { query } from '@/lib/mssql'
import { syncAttSoftHolds } from '@/lib/attSoftHolds'
import { validateRosterOverride } from '@/lib/attSoftRules'
import { HIDDEN_TRUCKS } from '@/lib/hiddenTrucks'

const iso = (d: Date) => d.toISOString().slice(0, 10)
const utc = (s: string) => new Date(s + 'T00:00:00Z')
const range = (a: string, b: string) => (a === b ? a : `${a} to ${b}`)

const view = (r: { id: string; truck_number: string; action: string; start_date: Date; end_date: Date; reason: string; created_by_name: string; created_at: Date }) => ({
  id: r.id, truck_number: r.truck_number, action: r.action,
  start_date: iso(r.start_date), end_date: iso(r.end_date),
  reason: r.reason, created_by_name: r.created_by_name, created_at: r.created_at.toISOString(),
})

/** Run the sync so the change shows now; a failure leaves it to the next run (every 15 minutes). */
async function applyNow(userId: string): Promise<string | null> {
  try {
    const r = await syncAttSoftHolds({ createdBy: userId })
    return r.warnings.length ? r.warnings.join(' ') : null
  } catch (err) {
    console.error('[att-soft/roster] sync after change failed:', err)
    return 'Saved, but the soft holds could not be updated now; the next sync (within 15 minutes) will apply it.'
  }
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const rows = await prisma.attRosterOverride.findMany({
    where: { removed_at: null, end_date: { gte: utc(iso(new Date())) } },
    orderBy: [{ start_date: 'asc' }, { truck_number: 'asc' }],
  })
  return NextResponse.json({ overrides: rows.map(view) })
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { truck_number?: string; action?: string; start_date?: string; end_date?: string; reason?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const truck = String(body.truck_number ?? '').trim()
  const action = String(body.action ?? '')
  const start = String(body.start_date ?? ''), end = String(body.end_date ?? '')
  const reason = String(body.reason ?? '').trim().slice(0, 500)
  const today = iso(new Date())

  if (!truck) return NextResponse.json({ error: 'Choose a truck.' }, { status: 400 })
  const invalid = validateRosterOverride({ action, start, end, reason }, today)
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })

  const [known] = await query<{ truck_number: string }[]>(
    `SELECT TOP 1 truck_number FROM dbo.trucks WHERE truck_number = @truck AND COALESCE(is_deleted, 0) = 0`,
    { truck },
  )
  if (!known || HIDDEN_TRUCKS.has(truck)) {
    return NextResponse.json({ error: `Truck ${truck} is not an active truck.` }, { status: 400 })
  }

  // Adding and removing the same truck on the same dates contradict each other.
  const opposite = await prisma.attRosterOverride.findFirst({
    where: {
      truck_number: truck, removed_at: null, action: action === 'ADD' ? 'REMOVE' : 'ADD',
      start_date: { lte: utc(end) }, end_date: { gte: utc(start) },
    },
  })
  if (opposite) {
    return NextResponse.json({
      error: `Truck ${truck} is already ${opposite.action === 'ADD' ? 'added to' : 'taken off'} the AT&T list for ${range(iso(opposite.start_date), iso(opposite.end_date))}. Undo that first.`,
    }, { status: 409 })
  }

  const row = await prisma.attRosterOverride.create({
    data: {
      truck_number: truck, action, start_date: utc(start), end_date: utc(end), reason,
      created_by: session.user.id, created_by_name: session.user.name ?? '',
    },
  })
  await prisma.auditLog.create({
    data: {
      action: action === 'ADD' ? 'ATT_LIST_ADD' : 'ATT_LIST_REMOVE',
      truck_number: truck, user_id: session.user.id,
      details: JSON.stringify({ override_id: row.id, start, end, reason }),
    },
  })

  const warning = await applyNow(session.user.id)
  return NextResponse.json({
    ok: true, override: view(row), warning,
    message: action === 'ADD'
      ? `Truck ${truck} is on the AT&T list for ${range(start, end)}.`
      : `Truck ${truck} is off the AT&T list for ${range(start, end)}; its soft holds on those dates are released.`,
  })
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { count } = await prisma.attRosterOverride.updateMany({
    where: { id, removed_at: null },
    data: { removed_at: new Date(), removed_by: session.user.id },
  })
  if (count === 0) return NextResponse.json({ error: 'That change no longer exists.' }, { status: 404 })
  const row = await prisma.attRosterOverride.findUniqueOrThrow({ where: { id } })
  await prisma.auditLog.create({
    data: {
      action: 'ATT_LIST_UNDO', truck_number: row.truck_number, user_id: session.user.id,
      details: JSON.stringify({ override_id: id, was: row.action, start: iso(row.start_date), end: iso(row.end_date) }),
    },
  })

  const warning = await applyNow(session.user.id)
  return NextResponse.json({
    ok: true, warning,
    message: `Undone. Truck ${row.truck_number} follows the automatic AT&T rule for ${range(iso(row.start_date), iso(row.end_date))} again.`,
  })
}

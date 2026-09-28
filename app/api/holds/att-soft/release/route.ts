/**
 * POST   /api/holds/att-soft/release — release a truck's AT&T soft hold for
 *        the dates of a specific booking (lib/attSoftRelease.ts). Any signed-in
 *        internal user; the page shows ATT_RELEASE_WARNING first; at most
 *        ATT_RELEASE_MAX_DAYS per release.
 * DELETE /api/holds/att-soft/release?id=… — undo a release, so the next sync
 *        reserves those dates for AT&T again.
 * Never exposed to the partner/MCP API or the client portal.
 */

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { releaseAttSoftForBooking, undoRelease, ReleaseError } from '@/lib/attSoftRelease'

const range = (a: string, b: string) => (a === b ? a : `${a} to ${b}`)

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
    // Say what actually happened: which soft-hold dates were cut, and that the
    // release is recorded for the whole booking either way.
    const cut = r.cut.map(c => range(c.start, c.end)).join(', ')
    return NextResponse.json({
      ok: true, ...r,
      message: cut
        ? `Released truck ${truck_number}'s AT&T soft hold for ${cut}. The rest stays reserved for AT&T.`
        : `Truck ${truck_number} has no AT&T soft hold on ${range(start_date, end_date)} yet; the release is recorded so none is created there.`,
    })
  } catch (err) {
    if (err instanceof ReleaseError) return NextResponse.json({ error: err.message }, { status: 400 })
    console.error('[att-soft/release] failed:', err)
    return NextResponse.json({ error: 'Release failed' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const undone = await undoRelease({ releaseId: id, userId: session.user.id })
  if (!undone) return NextResponse.json({ error: 'That release no longer exists.' }, { status: 404 })
  return NextResponse.json({
    ok: true, ...undone,
    message: `Undone. Truck ${undone.truckNumber} ${range(undone.start, undone.end)} goes back to AT&T at the next sync, if nothing else is booked there.`,
  })
}

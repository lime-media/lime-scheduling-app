/**
 * The AT&T soft-hold release the safety valve held back (lib/attSoftHolds.ts).
 *
 * GET  — what is held back: the trucks that no longer count as AT&T's, with
 *        the 160over90 days that counted, or { pending: null }.
 * POST — approve releasing those trucks: { trucks: string[] }, which must be
 *        among the held-back trucks. The sync runs straight away and releases
 *        them; any other mass drop later is still held back.
 *
 * Any signed-in internal user, as with every soft-hold release; audit-logged
 * per truck. Never exposed to the partner/MCP API or the client portal.
 */

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { approveMassRelease, getMassReleasePending, syncAttSoftHolds } from '@/lib/attSoftHolds'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ pending: await getMassReleasePending() })
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { trucks?: unknown; reason?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const trucks = Array.isArray(body.trucks) ? [...new Set(body.trucks.map(String))] : []
  const reason = String(body.reason ?? '').trim().slice(0, 300)
  if (!trucks.length) return NextResponse.json({ error: 'Choose the trucks to release.' }, { status: 400 })
  if (!reason) return NextResponse.json({ error: 'Say why, e.g. "Alloy Build ended".' }, { status: 400 })

  // Only what the valve is actually holding back — an approval is not a way
  // to release arbitrary trucks.
  const pending = await getMassReleasePending()
  const held = new Set(pending?.trucks.map(t => t.truck_number) ?? [])
  const unknown = trucks.filter(t => !held.has(t))
  if (!pending || unknown.length) {
    return NextResponse.json({
      error: unknown.length && pending
        ? `Not held back by the safety check: ${unknown.join(', ')}. Reload the page.`
        : 'Nothing is being held back right now. Reload the page.',
    }, { status: 409 })
  }

  await approveMassRelease({ trucks, by: session.user.id, byName: session.user.name ?? '', at: new Date().toISOString() })
  await prisma.auditLog.createMany({
    data: trucks.map(truck_number => ({
      action: 'ATT_MASS_RELEASE_APPROVED', truck_number, user_id: session.user.id,
      details: JSON.stringify({ reason, held_back_because: pending.reason }),
    })),
  })

  try {
    const r = await syncAttSoftHolds({ createdBy: session.user.id })
    return NextResponse.json({
      ok: true, released: r.releasedPremise, warnings: r.warnings,
      message: `Released ${r.releasedPremise} AT&T soft hold${r.releasedPremise === 1 ? '' : 's'} on ${trucks.length} truck${trucks.length === 1 ? '' : 's'}.`,
    })
  } catch (err) {
    console.error('[att-soft/mass-release] sync after approval failed:', err)
    return NextResponse.json({ ok: true, released: 0, message: 'Approved. The next sync (within 15 minutes) releases them.' })
  }
}

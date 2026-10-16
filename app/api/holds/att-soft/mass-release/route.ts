/**
 * The AT&T soft-hold release the safety valve held back (lib/attSoftHolds.ts).
 *
 * GET  — what is held back: the trucks that no longer count as AT&T's, with
 *        the 160over90 days that counted, or { pending: null }.
 * POST — approve releasing those trucks: { trucks: string[] }, which must be
 *        exactly the held-back trucks. All or nothing: approving part would
 *        release the rest too (as a small drop under the valve's threshold),
 *        so a partial set is refused rather than silently widened. To keep a
 *        truck, add it to the AT&T list first. The sync runs straight away;
 *        any other mass drop later is still held back.
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
  if (!pending) return NextResponse.json({ error: 'Nothing is being held back right now. Reload the page.' }, { status: 409 })
  const held = new Set(pending.trucks.map(t => t.truck_number))
  const same = trucks.length === held.size && trucks.every(t => held.has(t))
  if (!same) {
    return NextResponse.json({
      error: 'The trucks held back have changed since this page loaded, or not all of them were approved. '
        + 'Reload and review the list again; to keep a truck reserved for AT&T, add it to the list first.',
    }, { status: 409 })
  }

  const saved = await approveMassRelease({ trucks, by: session.user.id, byName: session.user.name ?? '', at: new Date().toISOString() })
  if (!saved) return NextResponse.json({ error: 'The approval could not be saved, so nothing was released. Try again.' }, { status: 500 })
  await prisma.auditLog.createMany({
    data: trucks.map(truck_number => ({
      action: 'ATT_MASS_RELEASE_APPROVED', truck_number, user_id: session.user.id,
      details: JSON.stringify({ reason, held_back_because: pending.reason }),
    })),
  })

  try {
    const r = await syncAttSoftHolds({ createdBy: session.user.id })
    const n = r.releasedPremiseTrucks.length
    return NextResponse.json({
      ok: true, released: r.releasedPremise, warnings: r.warnings,
      // What actually happened, counted from the sync, not from the request.
      message: `Released ${r.releasedPremise} AT&T soft hold${r.releasedPremise === 1 ? '' : 's'} on ${n} truck${n === 1 ? '' : 's'}.`
        + (n < trucks.length ? ` ${trucks.length - n} of the approved trucks had nothing left to release (they count as AT&T's again, or were released already).` : ''),
    })
  } catch (err) {
    console.error('[att-soft/mass-release] sync after approval failed:', err)
    return NextResponse.json({ ok: true, released: 0, message: 'Approved. The next sync (within 15 minutes) releases them.' })
  }
}

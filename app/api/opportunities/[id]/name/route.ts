import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { isSfdcConfigured, readOnlyPreview, salesforceWritesOff, updateOpportunityWithError, WRITES_OFF_MESSAGE, WRITES_STOPPED_ERROR } from '@/lib/salesforceClient'
import { getOpportunityStage } from '@/lib/sfdcOpportunityReconcile'
import { readOpportunityName, renameRefusal } from '@/lib/opportunityName'
import { rememberOpportunityName } from '@/lib/reservationOwners'

const SFDC_ID = /^[a-zA-Z0-9]{15,18}$/

/**
 * PATCH /api/opportunities/{id}/name  { name }
 *
 * Staff only. Renames a booking's Salesforce opportunity from Reservations,
 * while it's still open: the name the card shows comes from Salesforce
 * (lib/reservationOwners.ts), so a rename either side shows on the other.
 * Only an opportunity a booking in the app is on, read fresh from Salesforce
 * first; a closed one is refused (change it in Salesforce). Salesforce's own
 * refusal (a validation rule, writes off on UAT) is returned as the error.
 * Recorded in the audit log.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  if (!SFDC_ID.test(id)) return NextResponse.json({ error: 'Not a Salesforce opportunity id' }, { status: 400 })
  const body = await request.json().catch(() => null) as { name?: unknown } | null
  const read = readOpportunityName(body?.name)
  if ('error' in read) return NextResponse.json({ error: read.error }, { status: 400 })
  if (!read.name) return NextResponse.json({ error: 'The opportunity needs a name.' }, { status: 400 })
  const name = read.name

  if (!isSfdcConfigured()) return NextResponse.json({ error: "Salesforce isn't configured here, so the name wasn't changed." }, { status: 503 })
  // A preview (UAT) reads production Salesforce but never writes it: say so before anything is attempted.
  if (readOnlyPreview()) return NextResponse.json({ error: WRITES_OFF_MESSAGE, writesOff: true }, { status: 403 })
  // Writes stopped on production (SFDC_WRITES=off): refuse up front too, rather than as "Salesforce refused".
  if (salesforceWritesOff()) return NextResponse.json({ error: `${WRITES_STOPPED_ERROR}, so the name wasn't changed.` }, { status: 503 })

  // Only an opportunity one of the app's bookings is on, whether it's stored as the 15- or 18-character id.
  // Salesforce ids are case-sensitive but the database's LIKE isn't, so the match is re-checked here.
  const prefix = id.slice(0, 15)
  const hold = (await prisma.hold.findMany({
    where: { sfdc_opportunity_id: { startsWith: prefix } },
    select: { id: true, truck_number: true, sfdc_opportunity_id: true },
    take: 50,
  })).find(h => h.sfdc_opportunity_id?.slice(0, 15) === prefix)
  if (!hold) return NextResponse.json({ error: 'No booking in the app is on that opportunity.' }, { status: 404 })

  const stage = await getOpportunityStage(id)
  const refusal = renameRefusal(stage)
  if (refusal) return NextResponse.json({ error: refusal }, { status: stage ? 409 : 502 })

  const write = await updateOpportunityWithError(id, { Name: name })
    .catch((err): { ok: false; error: string } => ({ ok: false, error: err instanceof Error ? err.message : 'Salesforce could not be reached' }))
  if (!write.ok) return NextResponse.json({ error: `Salesforce refused the new name: ${write.error}` }, { status: 502 })

  rememberOpportunityName(id, name)
  await prisma.auditLog.create({
    data: {
      action: 'SFDC_OPPORTUNITY_RENAMED',
      truck_number: hold.truck_number,
      user_id: session.user.id,
      hold_id: hold.id,
      details: JSON.stringify({ opportunity_id: id, name }),
    },
  }).catch((err) => console.error('[opportunity-name] audit write failed:', err))
  return NextResponse.json({ name })
}

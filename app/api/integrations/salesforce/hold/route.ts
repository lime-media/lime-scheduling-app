import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getLiveVehicleLocations } from '@/lib/samsaraService'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'
import { endOfDayUtc } from '@/lib/dateOnly'

interface SfdcHoldPayload {
  opportunityId: string
  accountName:   string
  trucks:        string // multi-select picklist value, e.g. "7423;0820"
  holdStart:     string // yyyy-MM-dd
  holdStop:      string // yyyy-MM-dd
  holdExp?:      string // yyyy-MM-dd
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-sfdc-webhook-secret')
  if (!process.env.SFDC_WEBHOOK_SECRET || secret !== process.env.SFDC_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await req.json()) as Partial<SfdcHoldPayload>
  const { opportunityId, accountName, trucks, holdStart, holdStop, holdExp } = body

  if (!opportunityId || !accountName || !trucks || !holdStart || !holdStop) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const serviceUser = await prisma.user.findUnique({ where: { email: SFDC_SERVICE_USER_EMAIL } })
  if (!serviceUser) {
    return NextResponse.json({ error: `Service user ${SFDC_SERVICE_USER_EMAIL} not found — create it via the Users admin page first` }, { status: 500 })
  }

  const truckNumbers = trucks
    .split(/[;,]/)
    .map((t) => t.trim().replace(/^LED[\s-]*/i, ''))
    .filter(Boolean)

  if (truckNumbers.length === 0) {
    return NextResponse.json({ error: 'No truck numbers found in trucks field' }, { status: 400 })
  }

  const gpsMap = await getLiveVehicleLocations().catch(() => new Map())

  const start_date = new Date(holdStart)
  const end_date   = new Date(holdStop)
  const sfdc_hold_exp = holdExp ? new Date(holdExp) : null

  // Hold Exp is the last day the hold is valid, so it survives until the END of
  // that day. `new Date('2026-09-08')` is 00:00Z — the start — which would
  // release the truck a full calendar day early.
  const sfdc_expires_at = holdExp ? endOfDayUtc(holdExp) : null

  const now = new Date()
  // A pushed Hold Exp that has already passed does not reserve anything.
  // Salesforce re-pushes an Opportunity on any field edit, so this is the
  // common case for stale deals, not an edge case.
  const pushedExpiryIsFuture = sfdc_expires_at !== null && sfdc_expires_at > now
  const pushedExpiryIsPast   = sfdc_expires_at !== null && sfdc_expires_at <= now

  const results: Array<{ truck_number: string; hold_id: string; action: 'created' | 'updated' | 'removed' }> = []

  // Reconcile: drop holds this Opportunity previously pushed for trucks that
  // are no longer in its current LED Trucks list (e.g. a truck got swapped out).
  const stale = await prisma.hold.findMany({
    where: { sfdc_opportunity_id: opportunityId, source: 'SALESFORCE', truck_number: { notIn: truckNumbers } },
  })
  for (const hold of stale) {
    await prisma.auditLog.create({
      data: {
        action:       'DELETE_HOLD',
        truck_number: hold.truck_number,
        user_id:      serviceUser.id,
        hold_id:      hold.id,
        details:      JSON.stringify({ reason: 'sfdc_truck_removed_from_opportunity', opportunityId }),
      },
    })
    await prisma.hold.delete({ where: { id: hold.id } })
    results.push({ truck_number: hold.truck_number, hold_id: hold.id, action: 'removed' })
  }

  for (const truck_number of truckNumbers) {
    const gps    = gpsMap.get(truck_number)
    const market = gps ? `${gps.city}, ${gps.state}` : ''
    const state  = gps?.state ?? ''

    const existing = await prisma.hold.findFirst({
      where: { sfdc_opportunity_id: opportunityId, source: 'SALESFORCE', truck_number },
    })

    if (existing) {
      // A hold expired by expireHolds() means the deal was stale as of its old
      // Hold Exp date. A fresh push revives it ONLY if Salesforce sent a Hold Exp
      // that is still in the future.
      //
      // Reactivating on any push regardless of date is what made Salesforce holds
      // immortal: the sweep would expire a hold, the next sync would push the same
      // already-past Hold Exp and flip it straight back to HOLD, and the truck
      // stayed blocked forever while the UI showed a permanent "past due" badge.
      //
      // The mirror case matters too — if the push carries a Hold Exp that has
      // already passed, expire the hold here rather than leaving it active until
      // the next sweep happens to run.
      //
      // A COMMITTED hold is left alone in both directions; that's a real booking,
      // not something this webhook should revert.
      const reactivated = existing.status === 'EXPIRED' && pushedExpiryIsFuture
      const expiredNow  =
        pushedExpiryIsPast && (existing.status === 'HOLD' || existing.status === 'EXTENSION_REQUESTED')

      const updated = await prisma.hold.update({
        where: { id: existing.id },
        data: {
          market, state, client_name: accountName, start_date, end_date, sfdc_hold_exp,
          expires_at: sfdc_expires_at,
          ...(reactivated && { status: 'HOLD' }),
          ...(expiredNow  && { status: 'EXPIRED' }),
        },
      })
      results.push({ truck_number, hold_id: updated.id, action: 'updated' })
      await prisma.auditLog.create({
        data: {
          action:       'UPDATE_HOLD',
          truck_number,
          user_id:      serviceUser.id,
          hold_id:      updated.id,
          details:      JSON.stringify({
            source: 'salesforce', opportunityId, accountName, start_date, end_date,
            sfdc_hold_exp, expires_at: sfdc_expires_at,
            ...(reactivated && { reactivated_from_expired: true }),
            ...(expiredNow  && { expired_on_push: 'sfdc_hold_exp_already_passed' }),
            ...(existing.status === 'EXPIRED' && !reactivated && {
              left_expired: sfdc_hold_exp === null
                ? 'no_hold_exp_on_push'
                : 'sfdc_hold_exp_already_passed',
            }),
          }),
        },
      })
    } else {
      const created = await prisma.hold.create({
        data: {
          truck_number,
          market,
          state,
          client_name:         accountName,
          start_date,
          end_date,
          // An Opportunity pushed with a Hold Exp already in the past has nothing
          // left to reserve — record it, but don't let it block the truck.
          status:              pushedExpiryIsPast ? 'EXPIRED' : 'HOLD',
          source:              'SALESFORCE',
          notes:               `Auto-created from Salesforce Opportunity ${opportunityId}${market ? '' : ' — market/state unknown, no live GPS for this truck'}`,
          created_by:          serviceUser.id,
          sfdc_opportunity_id: opportunityId,
          sfdc_hold_exp,
          expires_at:          sfdc_expires_at,
        },
      })
      results.push({ truck_number, hold_id: created.id, action: 'created' })
      await prisma.auditLog.create({
        data: {
          action:       'CREATE_HOLD',
          truck_number,
          user_id:      serviceUser.id,
          hold_id:      created.id,
          details:      JSON.stringify({ source: 'salesforce', opportunityId, accountName, start_date, end_date }),
        },
      })
    }
  }

  return NextResponse.json({ results })
}

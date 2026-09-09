import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getLiveVehicleLocations } from '@/lib/samsaraService'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'
import { endOfDayUtc } from '@/lib/dateOnly'
import { HOLD_EXPIRATION_HOURS } from '@/lib/holdRequestService'
import { getOpportunityStage } from '@/lib/sfdcOpportunityReconcile'

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

  const now = new Date()

  const start_date    = new Date(holdStart)
  const end_date      = new Date(holdStop)
  const sfdc_hold_exp = holdExp ? new Date(holdExp) : null

  // Only act on Opportunities whose LED fields are actually filled in. The
  // required-field guard above covers presence; this covers garbage that still
  // parses as a string but not as a date, which would otherwise be written to
  // the row as Invalid Date.
  if (
    isNaN(start_date.getTime()) ||
    isNaN(end_date.getTime()) ||
    (sfdc_hold_exp !== null && isNaN(sfdc_hold_exp.getTime()))
  ) {
    return NextResponse.json(
      { error: 'Invalid date in holdStart, holdStop or holdExp — expected yyyy-MM-dd' },
      { status: 400 }
    )
  }

  // Hold Exp is the last day the hold is valid, so it survives until the END of
  // that day. `new Date('2026-09-08')` is 00:00Z — the start — which would
  // release the truck a full calendar day early.
  const explicitExpiry = holdExp ? endOfDayUtc(holdExp) : null

  // An LED Opportunity is supposed to carry Hold Exp alongside trucks, start and
  // stop. If the first three are filled in and only the expiration is missing,
  // fall back to the standard 72h review window rather than writing a null
  // expires_at — a null can never be matched by expireHolds(), so the hold would
  // reserve the truck forever with no badge and nothing to sweep it up.
  // The fallback is a ONE-TIME grant, not a renewable one. Resolved per hold
  // below, because an existing row's own expiry has to win over a fresh default —
  // otherwise a stale Opportunity that keeps syncing without a Hold Exp would
  // push its window out by 72h on every sync and never expire either.
  const defaultExpiry = new Date(now.getTime() + HOLD_EXPIRATION_HOURS * 60 * 60 * 1000)

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
      //
      // Expiry resolution, in order: an explicit Hold Exp always wins; failing
      // that the row keeps the expiry it already has, so repeated pushes can't
      // renew a 72h fallback forever; only a row with nothing at all (a legacy
      // null) gets a fresh default.
      const effectiveExpiry = explicitExpiry ?? existing.expires_at ?? defaultExpiry
      const expiryDefaulted = explicitExpiry === null && existing.expires_at === null
      const expiryIsPast    = effectiveExpiry <= now

      // Reviving an expired hold is the one place this webhook can undo the
      // hourly Opportunity reconcile, so it's worth a stage lookup here — and
      // only here, since reactivation is rare. Without it, editing a Closed Lost
      // Opportunity would flip its hold back to HOLD, the next sweep would close
      // it again, and the truck would flap hourly.
      //
      // A null stage means "couldn't ask" — fall through to the old behaviour and
      // let the sweep settle it within the hour, rather than dropping a revival
      // that may well be legitimate.
      let revivalStage: Awaited<ReturnType<typeof getOpportunityStage>> = null
      if (existing.status === 'EXPIRED' && !expiryIsPast) {
        revivalStage = await getOpportunityStage(opportunityId)
      }
      const blockedByClosedLost = revivalStage?.isClosed === true && revivalStage.isWon === false
      // A won deal coming back is a real booking, not a tentative hold.
      const revivedAsCommitted  = revivalStage?.isClosed === true && revivalStage.isWon === true

      const reactivated = existing.status === 'EXPIRED' && !expiryIsPast && !blockedByClosedLost
      const expiredNow  =
        expiryIsPast && (existing.status === 'HOLD' || existing.status === 'EXTENSION_REQUESTED')

      // A committed booking's expiry is meaningless — nothing expires it — so don't
      // restamp one. Left unguarded, a re-saved Closed Won Opportunity would write
      // its old past Hold Exp onto a COMMITTED row, and an un-commit back to HOLD
      // would then expire it on the spot.
      const isCommitted = existing.status === 'COMMITTED'

      const updated = await prisma.hold.update({
        where: { id: existing.id },
        data: {
          market, state, client_name: accountName, start_date, end_date, sfdc_hold_exp,
          ...(isCommitted ? {} : { expires_at: effectiveExpiry }),
          ...(reactivated && { status: revivedAsCommitted ? 'COMMITTED' : 'HOLD' }),
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
            sfdc_hold_exp,
            ...(isCommitted
              ? { expires_at_untouched: 'hold_is_committed' }
              : { expires_at: effectiveExpiry }),
            ...(expiryDefaulted && { expires_at_defaulted: 'no_hold_exp_on_push_72h' }),
            ...(explicitExpiry === null && existing.expires_at !== null && {
              expires_at_retained: 'no_hold_exp_on_push_kept_existing',
            }),
            ...(reactivated && {
              reactivated_from_expired: true,
              reactivated_as: revivedAsCommitted ? 'COMMITTED' : 'HOLD',
            }),
            ...(blockedByClosedLost && {
              reactivation_blocked: 'sfdc_opportunity_closed_lost',
              stage_name: revivalStage?.stageName,
            }),
            ...(expiredNow  && { expired_on_push: 'expiry_already_passed' }),
            ...(existing.status === 'EXPIRED' && !reactivated && {
              left_expired: 'expiry_already_passed',
            }),
          }),
        },
      })
    } else {
      // No prior row, so there is nothing to preserve — an absent Hold Exp gets
      // the one-time 72h fallback here.
      const newExpiry = explicitExpiry ?? defaultExpiry

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
          status:              newExpiry <= now ? 'EXPIRED' : 'HOLD',
          source:              'SALESFORCE',
          notes:               `Auto-created from Salesforce Opportunity ${opportunityId}`
                                 + (market ? '' : ' — market/state unknown, no live GPS for this truck')
                                 + (explicitExpiry === null ? ' — no Hold Exp on the Opportunity, defaulted to 72h' : ''),
          created_by:          serviceUser.id,
          sfdc_opportunity_id: opportunityId,
          sfdc_hold_exp,
          expires_at:          newExpiry,
        },
      })
      results.push({ truck_number, hold_id: created.id, action: 'created' })
      await prisma.auditLog.create({
        data: {
          action:       'CREATE_HOLD',
          truck_number,
          user_id:      serviceUser.id,
          hold_id:      created.id,
          details:      JSON.stringify({
            source: 'salesforce', opportunityId, accountName, start_date, end_date,
            sfdc_hold_exp, expires_at: newExpiry,
            ...(explicitExpiry === null && { expires_at_defaulted: 'no_hold_exp_on_push_72h' }),
            ...(newExpiry <= now && { created_expired: 'expiry_already_passed' }),
          }),
        },
      })
    }
  }

  return NextResponse.json({ results })
}

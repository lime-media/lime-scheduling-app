import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { canonicalMarketName } from '@/lib/marketBounds'
import { SFDC_SERVICE_USER_EMAIL, appHasNotReleased, appHoldExpOf, opportunityMarketCandidates, pushedHoldExpiry, trucksToMirror, withAppHoldExp } from '@/lib/sfdcIntegration'
import { syncOpportunityLedWindow } from '@/lib/sfdcBooking'
import { ledFieldsDiffer, ledWindowFields } from '@/lib/opportunityMerge'
import { loadOpportunityReservingHolds } from '@/lib/bookingLoad'
import { QUOTE_ONLY_ORIGINATION } from '@/lib/quoteOnly'
import { isSfdcConfigured, sfdcQuery } from '@/lib/salesforceClient'
import { soqlString } from '@/lib/soql'
import { endOfDayUtc } from '@/lib/dateOnly'
import { HOLD_EXPIRATION_HOURS } from '@/lib/holdExpiry'
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

  // Where the campaign runs, from the Opportunity — never where the truck
  // happens to be parked now.
  const destination = await opportunityDestination(opportunityId)
  const known = destination.status === 'ok' ? destination : null

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

  // An opportunity the app has booked on is the app's: for app-made bookings,
  // trucks and Hold Exp change only in the app (Andrew, Oct 2026). A push's
  // LED fields never create, change or delete holds here. When they differ
  // from what the app would write, the app writes its own back and records
  // it; the push that follows then matches, so this can't loop. Opportunities
  // made purely in Salesforce (no app booking, or only quote-only logs) are
  // mirrored below as before.
  // While the app holds trucks there (booked, not yet released — not a
  // quote-only log), the opportunity is the app's. A hold past its expiry the
  // sweep hasn't reached still counts: the sweep releases it and re-syncs LED
  // Trucks. Once the app's booking is released, Salesforce is in charge again
  // and the push is mirrored below.
  const appHolds = await prisma.hold.findMany({
    where:  { sfdc_opportunity_id: opportunityId, source: { not: 'SALESFORCE' }, origination: { not: QUOTE_ONLY_ORIGINATION } },
    select: { status: true },
  })
  if (appHolds.some(appHasNotReleased)) {
    const want = ledWindowFields(await loadOpportunityReservingHolds(opportunityId), now.toISOString().slice(0, 10))
    if (!ledFieldsDiffer(want, truckNumbers, holdExp ?? null)) {
      return NextResponse.json({ results: [], app_owned: true })
    }
    const warning = await syncOpportunityLedWindow(opportunityId)
    await prisma.auditLog.create({
      data: {
        action:       'SFDC_LED_FIELDS_OVERRIDDEN',
        truck_number: truckNumbers[0],
        user_id:      serviceUser.id,
        details:      JSON.stringify({
          opportunityId, pushed: { trucks: truckNumbers, holdExp: holdExp ?? null }, app: want,
          result: warning ?? (isSfdcConfigured() ? 'sync_requested' : 'salesforce_not_configured'),
        }),
      },
    })
    return NextResponse.json({ results: [], app_owned: true, overridden: true, ...(warning ? { warning } : {}) })
  }

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

  // Here the app has released everything on the opportunity (it would have
  // returned above), so every pushed truck is mirrored, including one from an
  // app booking that lapsed: a mirror path records, and a clash surfaces
  // through /api/holds/infeasible. A later Reinstate removes such copies of
  // its own trucks.
  const linkedHolds = await prisma.hold.findMany({
    where: { sfdc_opportunity_id: opportunityId },
    select: { truck_number: true, source: true, origination: true, status: true, features: true, sfdc_hold_exp: true },
  })
  const toMirror = trucksToMirror(truckNumbers, linkedHolds)
  const skippedAppHeld = truckNumbers.filter(t => !toMirror.includes(t))
  // The LED Hold Exp the app last wrote here, as recorded on this
  // opportunity's Salesforce-made rows. A push carrying it is the app's echo:
  // a truck first seen in such a push takes its siblings' Salesforce date
  // (blank stays blank, so the deal still never closes as lost), not the
  // app's date as if Salesforce had sent it.
  const salesforceRows = linkedHolds.filter(h => h.source === 'SALESFORCE')
  const appMarker = salesforceRows.map(h => appHoldExpOf(h.features)).find((d): d is string => !!d) ?? null
  const pushIsEcho = !!holdExp && !!appMarker && holdExp.slice(0, 10) === appMarker
  // On an echo, a new row takes the Salesforce date its siblings carry if they
  // agree, else none: blank-Hold-Exp protection is never lost to row order.
  const siblingDates = [...new Set(salesforceRows.map(h => h.sfdc_hold_exp?.toISOString() ?? null))]
  const echoSfdcHoldExp = siblingDates.length === 1 && siblingDates[0] ? new Date(siblingDates[0]) : null

  // The Opportunity's stage, asked at most once per push and only when a hold
  // would be revived, expired or created: a Closed Won deal's holds are
  // committed (booked, no expiry), never expired by a past Hold Exp and never
  // created as tentative HOLDs waiting for the reconcile. A null stage means
  // "couldn't ask": the old behaviour stands and the reconcile settles it.
  let stagePromise: ReturnType<typeof getOpportunityStage> | null = null
  const opportunityStage = () => (stagePromise ??= getOpportunityStage(opportunityId))
  const isWon = (s: Awaited<ReturnType<typeof getOpportunityStage>>) => s?.isClosed === true && s.isWon === true

  for (const truck_number of toMirror) {
    // Only a market the Opportunity names is written. When Salesforce can't be
    // reached, or the Opportunity names none, an existing hold keeps its market.
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
      // Expiry resolution, in order (lib/sfdcIntegration.ts pushedHoldExpiry):
      // the echo of the app's own Hold Exp write (the date recorded in this
      // row's features, appHoldExpOf) keeps the row's expiry, so the app's sync never
      // re-dates, shortens or revives a hold; otherwise an explicit Hold Exp
      // wins; failing that the row keeps the expiry it already has, so repeated
      // pushes can't renew a 72h fallback forever; only a row with nothing at
      // all (a legacy null) gets a fresh default.
      const { expiresAt: effectiveExpiry, echo } = pushedHoldExpiry({
        pushedHoldExp: holdExp ?? null, appHoldExp: appHoldExpOf(existing.features), current: existing.expires_at, fallback: defaultExpiry,
      })
      const expiryDefaulted = explicitExpiry === null && existing.expires_at === null
      const expiryIsPast    = effectiveExpiry <= now

      // Reviving an expired hold is the one place this webhook can undo the
      // Opportunity reconcile (every 15 minutes), so it's worth a stage lookup here — and
      // only here, since reactivation is rare. Without it, editing a Closed Lost
      // Opportunity would flip its hold back to HOLD, the next sweep would close
      // it again, and the truck would flap on every run.
      //
      // A null stage means "couldn't ask" — fall through to the old behaviour and
      // let the sweep settle it within the hour, rather than dropping a revival
      // that may well be legitimate.
      let revivalStage: Awaited<ReturnType<typeof getOpportunityStage>> = null
      if (existing.status === 'EXPIRED' && !expiryIsPast) {
        revivalStage = await opportunityStage()
      }
      const blockedByClosedLost = revivalStage?.isClosed === true && revivalStage.isWon === false
      // A won deal coming back is a real booking, not a tentative hold.
      const revivedAsCommitted  = isWon(revivalStage)

      const reactivated = existing.status === 'EXPIRED' && !expiryIsPast && !blockedByClosedLost
      const pastDue = expiryIsPast && (existing.status === 'HOLD' || existing.status === 'EXTENSION_REQUESTED')
      // A past Hold Exp on a won deal does not release it: the deal is booked.
      const committedNow = pastDue && isWon(await opportunityStage())
      const expiredNow   = pastDue && !committedNow

      // A committed booking's expiry is meaningless — nothing expires it — so don't
      // restamp one. Left unguarded, a re-saved Closed Won Opportunity would write
      // its old past Hold Exp onto a COMMITTED row, and an un-commit back to HOLD
      // would then expire it on the spot.
      const isCommitted = existing.status === 'COMMITTED'

      const updated = await prisma.hold.update({
        where: { id: existing.id },
        data: {
          ...(known ? { market: known.market, state: known.state } : {}),
          client_name: accountName, start_date, end_date,
          // The echo carries the app's own date, not one Salesforce set: keep
          // what the row had, so a booking pushed with Hold Exp blank still
          // never closes as lost (expiryClosesOpportunity).
          sfdc_hold_exp: echo ? existing.sfdc_hold_exp : sfdc_hold_exp,
          // A different date Salesforce set replaces the app's: drop the marker,
          // so only the app's latest write ever counts as an echo (the app's own
          // date on a committed row, which has no expiry to keep, leaves it).
          ...(holdExp && appHoldExpOf(existing.features) && appHoldExpOf(existing.features) !== holdExp.slice(0, 10) ? { features: withAppHoldExp(existing.features, null) } : {}),
          ...(isCommitted || committedNow || (reactivated && revivedAsCommitted) ? {} : { expires_at: effectiveExpiry }),
          ...(reactivated && { status: revivedAsCommitted ? 'COMMITTED' : 'HOLD' }),
          ...(reactivated && revivedAsCommitted && { expires_at: null }),
          ...(committedNow && { status: 'COMMITTED', expires_at: null, extension_until: null, extension_reason: null }),
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
            sfdc_hold_exp: echo ? existing.sfdc_hold_exp : sfdc_hold_exp,
            ...(isCommitted
              ? { expires_at_untouched: 'hold_is_committed' }
              : { expires_at: effectiveExpiry }),
            ...(expiryDefaulted && { expires_at_defaulted: 'no_hold_exp_on_push_72h' }),
            ...(echo && { expires_at_kept: 'echo_of_app_hold_exp' }),
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
            ...(committedNow && { committed_on_push: 'opportunity_closed_won' }),
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
      // A Closed Won deal's truck is booked: committed, no expiry.
      const won = isWon(await opportunityStage())

      const created = await prisma.hold.create({
        // MIRROR PATH — no feasibility gate by design. This reflects a booking
        // that already exists upstream; refusing it would drop a record the
        // source system believes is real. Infeasible holds created here are
        // reported by GET /api/holds/infeasible instead of being blocked.
        data: {
          truck_number,
          market:              known?.market ?? '',
          state:               known?.state ?? '',
          client_name:         accountName,
          start_date,
          end_date,
          // An Opportunity pushed with a Hold Exp already in the past has nothing
          // left to reserve — record it, but don't let it block the truck.
          status:              won ? 'COMMITTED' : newExpiry <= now ? 'EXPIRED' : 'HOLD',
          source:              'SALESFORCE',
          notes:               `Auto-created from Salesforce Opportunity ${opportunityId}`
                                 + (known ? '' : destination.status === 'unreachable'
                                     ? ' — market unknown: Salesforce could not be reached (a later push fills it in)'
                                     : ' — market unknown: the Opportunity names no market (Markets__c)')
                                 + (explicitExpiry === null ? ' — no Hold Exp on the Opportunity, defaulted to 72h' : ''),
          created_by:          serviceUser.id,
          sfdc_opportunity_id: opportunityId,
          sfdc_hold_exp:       pushIsEcho ? echoSfdcHoldExp : sfdc_hold_exp,
          ...(pushIsEcho && { features: withAppHoldExp(null, appMarker) }),
          expires_at:          won ? null : newExpiry,
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
            sfdc_hold_exp: pushIsEcho ? echoSfdcHoldExp : sfdc_hold_exp,
            expires_at: won ? null : newExpiry,
            ...(pushIsEcho && { sfdc_hold_exp_from_siblings: 'echo_of_app_hold_exp' }),
            ...(won && { created_committed: 'opportunity_closed_won' }),
            ...(!won && explicitExpiry === null && { expires_at_defaulted: 'no_hold_exp_on_push_72h' }),
            ...(!won && newExpiry <= now && { created_expired: 'expiry_already_passed' }),
          }),
        },
      })
    }
  }

  return NextResponse.json({ results, ...(skippedAppHeld.length ? { skipped_app_held: skippedAppHeld } : {}) })
}

/**
 * The market an Opportunity's trucks are going to, from its Markets__c (or a
 * rep-style name). One market resolves to the canonical name and state, so
 * the hold can be located for feasibility. Several markets (a multi-market RFP
 * that does not say which truck goes where) are listed as written, e.g.
 * "Multi-market: Detroit, Los Angeles, CA, Austin", with no state.
 *   ok          — a market to write
 *   none        — Salesforce answered, but the Opportunity names no market
 *   unreachable — Salesforce could not be asked
 */
type Destination = { status: 'ok'; market: string; state: string } | { status: 'none' | 'unreachable' }

async function opportunityDestination(opportunityId: string): Promise<Destination> {
  if (!isSfdcConfigured()) return { status: 'unreachable' }
  try {
    const rows = await sfdcQuery<{ Name: string | null; Markets__c: string | null }>(
      `SELECT Name, Markets__c FROM Opportunity WHERE Id = '${soqlString(opportunityId)}' LIMIT 1`,
    )
    if (!rows[0]) return { status: 'unreachable' }
    const candidates = opportunityMarketCandidates(rows[0].Markets__c, rows[0].Name)
    if (candidates.length === 0) return { status: 'none' }
    if (candidates.length > 1) return { status: 'ok', market: `Multi-market: ${candidates.join(', ')}`, state: '' }
    const [city, st] = candidates[0].split(',').map(x => x.trim())
    const canonical = await canonicalMarketName(candidates[0], st || undefined)
    if (canonical) return { status: 'ok', market: canonical, state: canonical.split(',')[1]?.trim() ?? '' }
    // Not a market we know (a venue, a region): keep it as written.
    return { status: 'ok', market: st ? candidates[0] : city, state: st && /^[A-Z]{2}$/i.test(st) ? st.toUpperCase() : '' }
  } catch (err) {
    console.error('[sfdc/hold] could not read the Opportunity market:', err)
    return { status: 'unreachable' }
  }
}

/**
 * POST /api/plan/hold — place holds for the markets the rep selected from a
 * multi-market quote, and create one Salesforce opportunity for them.
 *
 * The order is routed again here from fresh data, never from the browser's
 * copy: trucks may have been booked since the quote was shown. Holds are then
 * placed exactly as the fresh plan assigns them.
 *
 * Holds are placed by market. A truck on one market gets one hold per job. A
 * truck that alternates week to week between two markets gets a hold for each
 * stretch it spends in each market (rotationStints), back to back and never
 * overlapping, so the schedule shows where the truck actually is and each
 * hold carries its own market.
 *
 * Safety:
 * - All or nothing. Every stretch is checked against existing holds before
 *   anything is written; any clash returns 409 and nothing is booked. The
 *   holds are then written in one transaction, so a failure leaves none.
 * - Idempotent. The browser sends a request id per booking attempt. Holds are
 *   grouped under ids derived from it, so a retry after a timeout finds the
 *   first attempt's holds and returns them instead of booking a second set.
 * - No silent repricing. The browser sends the total it showed; if the fresh
 *   plan prices differently, 409 with the new total, and the rep confirms.
 *
 * What a linked client can see. Holds carry client_user_id when the account is
 * linked, and the client portal shows each hold's notes, features and total.
 * So each hold carries only its own market's client-facing figures, in the
 * QuoteFeatures shape the breakdown component reads — never our transport
 * cost, fleet counts or other markets' data.
 *
 * Partial bookings. Markets the rep did not select, and trucks the fleet can
 * no longer cover (booked only when the rep confirms), are left out of the
 * holds and the opportunity amount, and listed in the opportunity's
 * Description as quoted but not booked.
 */

import { withUsageLog } from '@/lib/usageLog'
import { opportunityName, savedBrand } from '@/lib/brand'
import { readOpportunityType, suggestedOpportunityType } from '@/lib/sfdcOpportunityType'
import { QUOTE_ONLY_GROUP_PREFIX, QUOTE_ONLY_NO_TRUCK, QUOTE_ONLY_NOTE, QUOTE_ONLY_ORIGINATION, QUOTE_ONLY_STATUS, bookingEvent } from '@/lib/quoteOnly'
import { openStage } from '@/lib/sfdcStages'
import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere, holdReservesNow } from '@/lib/holdFilters'
import { bookingHoldExpiry, holdUntilRefusal, parseHoldUntilFrom, reviseHoldExpiry, parseHoldDays, MAX_HOLD_DAYS, STAFF_MIN_DAYS_BEFORE_START } from '@/lib/holdExpiry'
import { getSfdcAccountInfo, isSfdcConfigured, checkPrimaryContact, resolveOpportunityOwner, readOnlyPreview, salesforceWritesOff, WRITES_OFF_MESSAGE, WRITES_STOPPED_ERROR } from '@/lib/salesforceClient'
import { createAppOpportunity } from '@/lib/opportunityOrigins'
import { chosenClientType } from '@/lib/pricing/brandMarkup'
import { NEED_LEAD_SOURCE, readLeadSource } from '@/lib/sfdcLeadSource'
import { loadBookingHolds } from '@/lib/bookingLoad'
import { reviseRefusal, summarizeBooking } from '@/lib/bookings'
import { AMOUNT_LEFT_NOTE, WINDOW_LEFT_NOTE, CLIENT_TYPE_LEFT_NOTE, applyBookingToOpportunity, getBookingOpportunity, opportunityRefusal, reopenClosedLostOpportunity, type BookingOpportunity } from '@/lib/sfdcBooking'
import { SFDC_SERVICE_USER_EMAIL, attachedToOpportunity, reactivationDecision, reopenQuestion } from '@/lib/sfdcIntegration'
import { bookWhatFits, buildMultiMarketQuote, holdPlaces, resolveRows, validateQuoteRequest, type QuoteRequest } from '@/lib/planning/quote'
import { describeBooked, describeQuoted, fitNames, lineFeatures, money, planStretches, planTier, studiesDescription } from '@/lib/planning/booking'
import { VALID_STUDIES, type StudyType } from '@/lib/pricing/config'
import { centralDate, holdExpDate } from '@/lib/dateOnly'
import { recordBooking } from '@/lib/transportMetricsRecord'
import { HoldClashError, HoldLockTimeoutError, writeHoldsExclusive } from '@/lib/holdWriteLock'
import { legsFromArrivals } from '@/lib/transportMetrics'

export const maxDuration = 300

type HoldBody = QuoteRequest & {
  sfdcAccountName?: string
  /** The brand the seller typed; cleaned before it goes to Salesforce (lib/brand.ts). */
  brand?: string
  /** Row ids to book. Omitted: every row. */
  selectedIds?: string[]
  /** Book what can be covered when some trucks no longer can be. */
  allowPartial?: boolean
  /** One id per booking attempt; a retry with the same id returns the first result. */
  requestId?: string
  /** The total the rep saw for the selected markets; booking stops if the fresh price differs. */
  expectedTotal?: number
  /** Opportunity stage the seller chose: Cold, Warm or Hot (never closed). */
  stage?: string
  /** A new opportunity's Lead Source, from Salesforce's picklist (lib/sfdcLeadSource.ts). Required for one. */
  leadSource?: string
  /** Opportunity Type the seller picked (lib/sfdcOpportunityType.ts). */
  opportunityType?: string
  /** Low conviction: log a priced opportunity, reserve nothing (lib/quoteOnly.ts). */
  quoteOnly?: boolean
  /** The opportunity's primary contact: a Contact on the account. Required. */
  primaryContactId?: string
  /** How long to hold the trucks, in days (default 3, at most MAX_HOLD_DAYS). */
  holdDays?: number
  /**
   * A revision of a live booking only: its expiry date (YYYY-MM-DD, Central)
   * as the revise form shows it, opened on the booking's current expiry.
   * Unchanged keeps that expiry; changed sets this date (lib/holdExpiry.ts
   * reviseHoldExpiry). Used instead of holdDays.
   */
  holdUntil?: string
  /** With holdUntil: the booking's expiry (ISO) the revise form opened on, so an unchanged date keeps the expiry the booking has now. */
  holdUntilFrom?: string
  /**
   * Add this booking to an existing open opportunity of the account instead
   * of creating one. (Revising a booking — QuoteRequest.revise — always goes
   * onto that booking's own opportunity.)
   */
  attachOpportunityId?: string
  /**
   * A revision only: the person agreed to move the booking's Closed Lost
   * opportunity back to WARM (asked after a 409 `reopenable`). Ignored on an
   * attach, which only offers open opportunities.
   */
  reopenOpportunity?: boolean
}

async function handlePost(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: HoldBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body.sfdcAccountId) return NextResponse.json({ error: 'Select a Salesforce account first.' }, { status: 400 })
  if (!body.requestId || !/^[A-Za-z0-9_-]{8,64}$/.test(body.requestId)) return NextResponse.json({ error: 'Missing booking request id.' }, { status: 400 })
  const holdDays = parseHoldDays(body.holdDays)
  if (holdDays === null) return NextResponse.json({ error: `Hold for 1 to ${MAX_HOLD_DAYS} days.` }, { status: 400 })
  if (body.holdUntil !== undefined && (typeof body.holdUntil !== 'string' || !body.revise?.bookingKey)) {
    return NextResponse.json({ error: 'A hold expiry date is only set when revising a booking.' }, { status: 400 })
  }
  // A real date, today or later, before any Salesforce read or routing; the
  // limit needs the routed starts, so reviseHoldExpiry checks it below.
  const holdUntilBad = body.holdUntil !== undefined && body.quoteOnly !== true ? holdUntilRefusal(body.holdUntil) : null
  if (holdUntilBad) return NextResponse.json({ error: holdUntilBad }, { status: 400 })
  // The expiry the form opened on comes with every holdUntil: without it an
  // unchanged date can't be told from a deliberate one (see parseHoldUntilFrom).
  const opened = body.holdUntil !== undefined && body.quoteOnly !== true ? parseHoldUntilFrom(body.holdUntilFrom) : null
  if (opened && 'error' in opened) return NextResponse.json({ error: opened.error }, { status: 400 })
  const holdUntilFrom = opened ? opened.from : null
  // A new opportunity's lead source: the seller picks one off Salesforce's
  // picklist. A revision or an attach keeps the opportunity's own (a
  // revision with no opportunity left makes one: checked once that's known).
  const lead = readLeadSource(body.leadSource, !body.revise?.bookingKey && !body.attachOpportunityId)
  if ('error' in lead) return NextResponse.json({ error: lead.error }, { status: 400 })
  const { leadSource } = lead
  // Its Opportunity Type, the same way: picked by the seller for a new one.
  const oppType = readOpportunityType(body.opportunityType, !body.revise?.bookingKey && !body.attachOpportunityId)
  if ('error' in oppType) return NextResponse.json({ error: oppType.error }, { status: 400 })
  // Every opportunity needs its primary contact, on this account — checked
  // after the cheap local guards. A definite no refuses; Salesforce being
  // unreachable only warns (see checkPrimaryContact).
  const contact = await checkPrimaryContact(body.primaryContactId, body.sfdcAccountId)
  if (contact.refusal) return NextResponse.json({ error: contact.refusal }, { status: 400 })
  const sfdcWarnings: string[] = contact.warning ? [contact.warning] : []

  // Changing a deal instead of starting a new one: a revision replaces a
  // booking's holds on its own opportunity; an attach adds to another open
  // opportunity of the account. Either way, the opportunity must be the
  // account's and not lost.
  const reviseKey = body.revise?.bookingKey
  if (reviseKey && body.attachOpportunityId) return NextResponse.json({ error: 'Revise a booking or add to an opportunity, not both.' }, { status: 400 })
  const reviseHolds = reviseKey ? await loadBookingHolds(reviseKey) : []
  // A retry of a revision that went through finds the old holds gone; the
  // retry guard below answers it ("already placed") from the new ones.
  const retryOfRevision = reviseKey && reviseHolds.length === 0 && await prisma.hold.count({
    where: { campaign_group_id: { startsWith: `${body.quoteOnly === true ? QUOTE_ONLY_GROUP_PREFIX : 'mm_'}${body.requestId}_` } },
  }) > 0
  if (reviseKey && !retryOfRevision) {
    const refusal = reviseRefusal(reviseHolds)
    if (refusal) return NextResponse.json({ error: refusal }, { status: 409 })
  }
  const targetOppId = reviseKey ? reviseHolds.find(h => h.sfdc_opportunity_id)?.sfdc_opportunity_id ?? null : body.attachOpportunityId ?? null
  if (targetOppId && !isSfdcConfigured()) return NextResponse.json({ error: 'Salesforce is not configured, so the opportunity cannot be updated.' }, { status: 503 })
  let target: BookingOpportunity | null = null
  // Adding to an opportunity Salesforce couldn't be reached to check: the
  // holds are still placed (unlinked) and the rep is told to add them by hand.
  let attachUnreachable = false
  const reviseIds = reviseHolds.map(h => h.id)

  body.features = body.features ?? { shadowFencing: true, smartDirectional: false, deviceId: false }
  // Only known studies, from the browser (lib/pricing/studies.ts prices them).
  body.features.studies = Array.isArray(body.features.studies)
    ? [...new Set(body.features.studies.filter((x): x is StudyType => (VALID_STUDIES as readonly unknown[]).includes(x)))]
    : []
  // Holds never displace AT&T: soft-hold trucks are always reserved here.
  body.reserveSoftHolds = true
  const invalid = validateQuoteRequest(body)
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })

  const quoteOnly = body.quoteOnly === true
  // Quote-only logs and real bookings live in separate id spaces, so a real
  // booking can never be mistaken for an earlier quote-only log of the same
  // quote (or the reverse) and answered "already placed" with nothing held.
  const groupPrefix = `${quoteOnly ? QUOTE_ONLY_GROUP_PREFIX : 'mm_'}${body.requestId}_`
  // The new booking's key (lib/bookings.ts bookingKey of its holds).
  const newKey = groupPrefix.replace(/_$/, '')

  try {
    // A retry of an attempt that already went through: return what it did.
    const earlier = await prisma.hold.findMany({
      where: { campaign_group_id: { startsWith: groupPrefix } },
      select: { truck_number: true, market: true, start_date: true, end_date: true, sfdc_opportunity_id: true },
    })
    if (earlier.length > 0) {
      const trucks = new Set(earlier.map(h => h.truck_number)).size
      return NextResponse.json({
        ok: true,
        alreadyPlaced: true,
        quoteOnly,
        created: earlier.map(h => ({ truckNumber: h.truck_number, market: h.market, start: h.start_date.toISOString().slice(0, 10), end: h.end_date.toISOString().slice(0, 10) })),
        sfdcOpportunityId: earlier.find(h => h.sfdc_opportunity_id)?.sfdc_opportunity_id ?? null,
        message: quoteOnly
          ? `This quote was already logged (${earlier.length} market${earlier.length === 1 ? '' : 's'}). Nothing new was logged; no trucks are reserved.`
          : `These holds were already placed: ${earlier.length} holds on ${trucks} truck${trucks === 1 ? '' : 's'}. Nothing new was booked.`,
      })
    }

    // The opportunity, after the retry guard so a retry is answered from its holds.
    if (targetOppId) {
      try {
        target = await getBookingOpportunity(targetOppId)
      } catch (err) {
        console.error('[plan/hold] opportunity read failed:', err)
        // A revision has to update its own opportunity; adding to one degrades.
        if (reviseKey) return NextResponse.json({ error: 'Salesforce could not be reached to check the opportunity. Nothing was booked; try again.' }, { status: 503 })
        attachUnreachable = true
      }
      // A revised booking whose opportunity no longer exists in Salesforce is
      // revised as one without an opportunity, as the planner said when it
      // opened it (app/api/bookings/revise): a new opportunity is created.
      // An opportunity picked to add to must exist.
      const lost = reviseKey && target
        ? reactivationDecision({ isClosed: target.IsClosed, isWon: target.IsWon, stageName: target.StageName }, body.reopenOpportunity === true)
        : { kind: 'allowed' as const }
      if (lost.kind === 'reopenable') {
        return NextResponse.json({
          error: opportunityRefusal(target, body.sfdcAccountId),
          reopenable: { opportunityId: target!.Id, stageName: lost.stageName, question: reopenQuestion(lost.stageName) },
        }, { status: 409 })
      }
      const refusal = attachUnreachable || (reviseKey && !target) ? null : opportunityRefusal(target, body.sfdcAccountId, { closedLostReopening: lost.kind === 'reopen' })
      if (refusal) return NextResponse.json({ error: refusal }, { status: 409 })
    }
    // A revised booking with no opportunity (none, or gone from Salesforce)
    // gets a new one, so it needs a lead source like any new booking. The
    // planner may not know yet (it went after the booking was opened): the
    // flag tells it to ask.
    if (reviseKey && !target && !leadSource) return NextResponse.json({ error: NEED_LEAD_SOURCE, needLeadSource: true }, { status: 400 })

    const { lines: allLines, errors } = await resolveRows(body.rows)
    if (errors.length) return NextResponse.json({ error: 'Some markets need attention.', rowErrors: errors }, { status: 400 })
    const selected = new Set(body.selectedIds ?? allLines.map(l => l.id))
    const chosen = allLines.filter(l => selected.has(l.id))
    if (chosen.length === 0) return NextResponse.json({ error: 'Select at least one market to book.' }, { status: 400 })

    // Route the selected markets from fresh data.
    let booking = await buildMultiMarketQuote(body, chosen, { alternatives: false })
    const asQuoted = booking.quote
    // A quote-only log reserves nothing, so markets the fleet cannot cover are
    // logged at their quoted price like the rest — nothing to confirm or trim.
    if (booking.plan.shortfalls.length > 0 && !quoteOnly) {
      if (!body.allowPartial) {
        return NextResponse.json({
          error: 'Not every selected market can be covered right now.',
          shortfalls: booking.plan.shortfalls,
        }, { status: 409 })
      }
      // Book what can be covered, routed and priced again (bookWhatFits).
      const fitted = await bookWhatFits(body, chosen, booking)
      if (!fitted) {
        return NextResponse.json({ error: 'No trucks can be assigned to the selected markets right now.' }, { status: 409 })
      }
      booking = fitted
    }
    const { quote, plan } = booking

    // The price the rep agreed to must still hold.
    if (typeof body.expectedTotal === 'number' && Math.abs(quote.summary.grandTotal - body.expectedTotal) >= 1) {
      return NextResponse.json({
        error: 'The price changed since the quote was shown.',
        priceChanged: { was: body.expectedTotal, now: quote.summary.grandTotal },
      }, { status: 409 })
    }

    // Every stretch to hold, with its market resolved for the hold record.
    const lineById = new Map(quote.lines.map(l => [l.id, l]))
    const place = await holdPlaces(booking)
    // One clock for every hold, so equal lengths give equal expiries (the
    // confirmation compares them to say whether markets lapse at different times).
    const holdClock = new Date()
    // Added to an existing opportunity, now or when the revised booking was:
    // its holds lapsing must not close that deal (expiryClosesOpportunity).
    const attached = !!target && (!!body.attachOpportunityId || reviseHolds.some(h => attachedToOpportunity(h.features)))
    const withAttach = <T extends object>(f: T) => (attached ? { ...f, attachedToOpportunity: true } : f)
    // A revision never cuts back an expiry ops already extended. (A committed,
    // Closed Won booking is never revised: reviseRefusal / opportunityRefusal.)
    const keepUntil = reviseHolds.filter(x => x.live).map(h => h.expires_at).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null
    const stints = planStretches(plan)
    // A multi-market booking is one quote with ONE expiry on every hold: the
    // seller's length, capped by the earliest start, or the later expiry the
    // revised booking already had, never past that cap (lib/holdExpiry.ts).
    // A revision that shows the expiry date keeps it unless the rep changed it.
    const heldStarts = stints.map(x => x.stint.start)
    // A quote-only revision holds nothing, so it has no expiry to check.
    // holdUntilFrom is always set with holdUntil here (refused above otherwise).
    const revisedExpiry = heldStarts.length > 0 && reviseKey && body.holdUntil !== undefined && holdUntilFrom
      ? reviseHoldExpiry(heldStarts, body.holdUntil, keepUntil, holdClock, STAFF_MIN_DAYS_BEFORE_START, centralDate(holdUntilFrom))
      : null
    if (revisedExpiry && 'error' in revisedExpiry) return NextResponse.json({ error: revisedExpiry.error, lastDate: revisedExpiry.lastDate }, { status: 400 })
    const bookingExpiry = revisedExpiry ?? (heldStarts.length ? bookingHoldExpiry(heldStarts, holdDays, holdClock, keepUntil, STAFF_MIN_DAYS_BEFORE_START) : null)
    const stretches = stints.map(x => ({ ...x, expiresAt: bookingExpiry?.expiresAt ?? holdClock }))

    // All or nothing: any stretch that now clashes stops the whole booking.
    // (A quote-only log blocks no truck, so there is nothing to clash with.)
    const truckNumbers = [...new Set(stretches.map(x => x.truckNumber))]
    const from = stretches.reduce((m, x) => (x.stint.start < m ? x.stint.start : m), stretches[0]?.stint.start ?? '')
    const to = stretches.reduce((m, x) => (x.stint.end > m ? x.stint.end : m), stretches[0]?.stint.end ?? '')
    const existing = quoteOnly || stretches.length === 0 ? [] : await prisma.hold.findMany({
      where: {
        // A revision's own holds are being replaced: they do not clash.
        ...(reviseIds.length ? { id: { notIn: reviseIds } } : {}),
        truck_number: { in: truckNumbers },
        ...activeHoldWhere({ excludeAttSoft: true }),
        start_date: { lte: new Date(to) },
        end_date: { gte: new Date(from) },
      },
      select: { truck_number: true, start_date: true, end_date: true },
    })
    const clashes = stretches.filter(x => existing.some(h =>
      h.truck_number === x.truckNumber
      && h.start_date.toISOString().slice(0, 10) <= x.stint.end
      && h.end_date.toISOString().slice(0, 10) >= x.stint.start))
    if (clashes.length > 0) {
      return NextResponse.json({
        error: `${new Set(clashes.map(c => c.truckNumber)).size} truck(s) were booked since this quote was built. Get a fresh quote and book again.`,
        clashes: clashes.map(c => ({ truckNumber: c.truckNumber, market: c.stint.market, start: c.stint.start, end: c.stint.end })),
      }, { status: 409 })
    }

    const accountName = body.sfdcAccountName || 'Client'
    const brand = savedBrand(body.brand) // "none" means no brand, as everywhere
    const linkedClient = await prisma.clientUser.findFirst({ where: { sfdc_account_id: body.sfdcAccountId }, select: { id: true } })
    const serviceUser = await prisma.user.findFirst({ where: { email: SFDC_SERVICE_USER_EMAIL }, select: { id: true } })
    const createdBy = (token.id as string) || serviceUser?.id || 'system'
    const tier = planTier(body.features, quote.studies.studies)
    // One campaign group per market, so each market reads as its own campaign
    // with its own total wherever holds are grouped.
    const groupOf = new Map(quote.lines.map((l, i) => [l.id, `${groupPrefix}${i + 1}`]))

    // Quote only: ONE record per selected market, as quoted — whether or not
    // the fleet could cover it — so every logged market is on record (and the
    // retry guard above always finds it). Not linked to the client portal.
    const trucksOf = (lineId: string) => [...new Set(stretches.filter(x => x.stint.lineId === lineId).map(x => x.truckNumber))]
    const quoteOnlyRows: Prisma.HoldCreateManyInput[] = quote.lines.map(lq => {
      const where = place.get(lq.id)!
      const assigned = trucksOf(lq.id)
      return {
        truck_number: assigned[0] ?? QUOTE_ONLY_NO_TRUCK,
        client_name: accountName,
        market: where.market,
        state: where.state,
        start_date: new Date(lq.startDate),
        end_date: new Date(lq.endDate),
        status: QUOTE_ONLY_STATUS,
        source: 'INTERNAL',
        origination: QUOTE_ONLY_ORIGINATION,
        notes: `${QUOTE_ONLY_NOTE} ${lq.market}, part of a ${quote.summary.markets}-market quote for ${accountName}${brand ? ` (brand: ${brand})` : ''}: ${lq.trucks} truck${lq.trucks === 1 ? '' : 's'} quoted`
          + (assigned.length ? `, priced on ${assigned.join(', ')}` : '')
          + (lq.missing ? `, ${lq.missing} with no truck available` : '') + '.',
        created_by: createdBy,
        client_user_id: null,
        pricing_tier: tier,
        quoted_total: lq.total,
        daily_rate: lq.effectiveDailyRate,
        features: JSON.stringify(withAttach(lineFeatures(lq, body.features, quote.brandMarkupPct, quote.clientType, quote.studies))),
        truck_count: lq.trucks,
        campaign_group_id: groupOf.get(lq.id)!,
        expires_at: new Date(),
        sfdc_opportunity_id: target?.Id ?? null,
      }
    })

    const rows: Prisma.HoldCreateManyInput[] = quoteOnly ? quoteOnlyRows : stretches.map(({ truckNumber, stint, partner, expiresAt }) => {
      const lq = lineById.get(stint.lineId)!
      const where = place.get(stint.lineId)!
      return {
        truck_number: truckNumber,
        client_name: accountName,
        market: where.market,
        state: where.state,
        start_date: new Date(stint.start),
        end_date: new Date(stint.end),
        // Never committed here: a Closed Won opportunity takes no new or revised booking (opportunityRefusal).
        status: 'HOLD',
        source: 'INTERNAL',
        origination: 'frontend',
        notes: `${lq.market}, part of a ${quote.summary.markets}-market order for ${accountName}${brand ? ` (brand: ${brand})` : ''}.`
          + (partner ? ` Truck alternates weekly with ${partner}.` : '')
          + (stint.travelTo ? ` Last day is travel to ${stint.travelTo}.` : ''),
        created_by: createdBy,
        client_user_id: linkedClient?.id ?? null,
        pricing_tier: tier,
        quoted_total: lq.total,
        daily_rate: lq.effectiveDailyRate,
        // The line's quote, plus what this hold itself sells: a rotating truck's
        // weekly stint works only some of the line's days (lib/ledJobs.ts daysSold).
        features: JSON.stringify({ ...withAttach(lineFeatures(lq, body.features, quote.brandMarkupPct, quote.clientType, quote.studies)), heldStart: stint.start, heldEnd: stint.end, heldWorkDays: stint.workDays }),
        truck_count: lq.trucks,
        campaign_group_id: groupOf.get(stint.lineId)!,
        expires_at: expiresAt,
        sfdc_opportunity_id: target?.Id ?? null,
      }
    })
    const CHUNK = 200
    // The revision's audit row is the only record of the booking it replaces
    // (the old holds are deleted), so it carries every column of every old
    // hold and is written in the same transaction as the delete: the record,
    // the delete and the new holds land together, or none of them do.
    const was = reviseIds.length ? await prisma.hold.findMany({ where: { id: { in: reviseIds } } }) : []
    // Under each truck's lock, re-checked for a hold placed since the check
    // above (lib/holdWriteLock.ts); the holds a revision replaces don't count.
    // A quote-only log reserves nothing, so it takes no lock.
    const writeAll = async (tx: Prisma.TransactionClient) => {
      if (reviseKey) await tx.auditLog.create({
        data: {
          action: 'REVISE_BOOKING',
          truck_number: truckNumbers[0] ?? reviseHolds[0]?.truck_number ?? '',
          user_id: createdBy,
          details: JSON.stringify({
            booking: reviseKey, now: newKey, opportunity: target?.Id ?? null,
            was, trucks: truckNumbers, total: quote.summary.grandTotal,
          }),
        },
      })
      if (reviseIds.length) await tx.hold.deleteMany({ where: { id: { in: reviseIds } } })
      // Its CampaignIQ request follows it to the new key, keeping the ref Core
      // was first sent (lib/campaignRequests.ts), so Core keeps one request.
      // A quote-only log reserves nothing: the request stays under the old
      // key, with no live holds left, to be declined.
      if (reviseKey && !quoteOnly) await tx.campaignRequestSync.updateMany({ where: { booking_key: reviseKey }, data: { booking_key: newKey } })
      for (let i = 0; i < rows.length; i += CHUNK) await tx.hold.createMany({ data: rows.slice(i, i + CHUNK) })
    }
    try {
      if (quoteOnly) await prisma.$transaction(writeAll)
      else await writeHoldsExclusive(stretches.map(x => ({ truck: x.truckNumber, start: x.stint.start, end: x.stint.end })), writeAll, { ignoreHoldIds: reviseIds, excludeAttSoft: true })
    } catch (err) {
      if (err instanceof HoldClashError) {
        return NextResponse.json({
          error: `${err.message} Nothing was booked. Get a fresh quote and book again.`,
          clashes: err.clashes.map(c => ({ truckNumber: c.truck, start: c.start, end: c.end })),
        }, { status: 409 })
      }
      if (err instanceof HoldLockTimeoutError) return NextResponse.json({ error: err.message }, { status: 409 })
      throw err
    }

    // A Closed Lost opportunity the person agreed to reopen goes back to WARM
    // only now, with the revision saved: a push the stage change sets off finds
    // the app's new holds live, so the webhook treats the opportunity as the
    // app's rather than mirroring its old trucks. If Salesforce refuses, the
    // revision is undone (the new holds go, the old ones come back from `was`,
    // every column) and nothing changes.
    if (reviseKey && target && body.reopenOpportunity === true && target.IsClosed && !target.IsWon) {
      const r = await reopenClosedLostOpportunity(target.Id)
      if (!r.ok) {
        // Put the old booking back. Its holds are normally lapsed already (the
        // deal was lost), but any that still reserve are re-checked under their
        // trucks' locks: a truck the revision let go may have been booked by
        // someone else during the Salesforce call. If so the revision stands.
        const fresh = await prisma.hold.findMany({ where: { campaign_group_id: { startsWith: groupPrefix } }, select: { id: true } })
        const now = new Date()
        try {
          await writeHoldsExclusive(
            was.filter(h => holdReservesNow(h, now)).map(h => ({ truck: h.truck_number, start: h.start_date.toISOString().slice(0, 10), end: h.end_date.toISOString().slice(0, 10) })),
            async tx => {
              await tx.hold.deleteMany({ where: { campaign_group_id: { startsWith: groupPrefix } } })
              if (was.length) await tx.hold.createMany({ data: was })
              // Its CampaignIQ request goes back with it to the old key.
              await tx.campaignRequestSync.updateMany({ where: { booking_key: newKey }, data: { booking_key: reviseKey } })
              await tx.auditLog.create({
                data: {
                  action: 'REVISE_REVERTED',
                  truck_number: truckNumbers[0] ?? reviseHolds[0]?.truck_number ?? '',
                  user_id: createdBy,
                  details: JSON.stringify({ booking: reviseKey, reason: 'salesforce_refused_reopen', error: r.error }),
                },
              })
            },
            { ignoreHoldIds: fresh.map(h => h.id), excludeAttSoft: true },
          )
        } catch (err) {
          if (err instanceof HoldClashError || err instanceof HoldLockTimeoutError) {
            return NextResponse.json({
              error: `${r.error} The revised booking was kept: the old one can't be put back (${err.message}).${readOnlyPreview() ? '' : ' Reopen the opportunity in Salesforce by hand.'}`,
            }, { status: 409 })
          }
          throw err
        }
        return NextResponse.json({ error: r.error }, { status: 409 })
      }
      target = { ...target, StageName: r.toStage, IsClosed: false }
      await prisma.auditLog.create({
        data: {
          action: 'REOPEN_OPPORTUNITY',
          truck_number: truckNumbers[0] ?? reviseHolds[0]?.truck_number ?? '',
          user_id: createdBy,
          details: JSON.stringify({
            opportunity_id: target.Id, from_stage: r.fromStage, to_stage: r.toStage,
            by: (token.email as string | undefined) ?? createdBy, for: 'REVISE_BOOKING', booking: reviseKey,
          }),
        },
      }).catch(err => console.error('[plan/hold] reopen audit failed:', err))
    }

    // What was quoted and is not being booked, for the opportunity's notes.
    const bookedTrucks = new Map(quote.lines.map(l => [l.id, l.trucks]))
    const unavailable = asQuoted.lines
      .filter(l => (bookedTrucks.get(l.id) ?? 0) < l.trucks)
      .map(l => describeQuoted(l, l.trucks - (bookedTrucks.get(l.id) ?? 0)))
    const notSelected = allLines.some(l => !selected.has(l.id))
      ? (await buildMultiMarketQuote(body, allLines, { alternatives: false })).quote.lines.filter(l => !selected.has(l.id))
      : []

    let sfdcOpportunityId: string | null = null
    let sfdcError: string | null = null
    // Markets as the holds name them (the standard market an imported DMA
    // resolved to), so a later revision can tell which ones it drops
    // (lib/opportunityMerge.ts REPLACE matches Markets__c against the holds).
    const oppMarkets = [...new Set(quote.lines.map(l => place.get(l.id)?.market ?? l.market))]
    if (attachUnreachable) {
      sfdcError = 'Salesforce could not be reached to add them to the opportunity'
    } else if (isSfdcConfigured()) {
      try {
        // The dates trucks actually work, not the requested range.
        const starts = quote.lines.map(l => l.delivery.firstDay ?? l.startDate).sort()
        const ends = quote.lines.map(l => l.delivery.lastDay ?? l.endDate).sort()
        const description = [
          ...(quoteOnly ? [`Quote only (low conviction): no trucks reserved. ${quote.lines.reduce((n, l) => n + l.trucks, 0)} trucks quoted across ${quote.lines.length} market${quote.lines.length === 1 ? '' : 's'}${truckNumbers.length ? `, priced on ${truckNumbers.join(', ')}` : ''}${quote.lines.some(l => l.missing) ? `; ${quote.lines.reduce((n, l) => n + l.missing, 0)} with no truck available` : ''}.`, ''] : []),
          // Internal record only: every price below already includes it.
          ...(quote.brandMarkupPct ? [`Brand Direct pricing: +${quote.brandMarkupPct}% folded into every line item.`, ''] : []),
          quoteOnly ? 'Quoted (no reservation):' : 'Booked:',
          ...quote.lines.map(l => `${describeBooked(l)}, ${money(l.total)}`),
          // Without the order's studies: they're priced once, on what's booked (studiesDescription).
          ...(notSelected.length ? ['', 'Quoted but not selected:', ...notSelected.map(l => `${describeQuoted(l)}, ${money(l.total - l.studiesTotal)}`)] : []),
          ...(unavailable.length ? ['', 'Quoted but no truck available:', ...unavailable] : []),
          ...studiesDescription(quote.studies),
        ].join('\n')
        const holdExp = stretches.length ? holdExpDate(new Date(Math.min(...stretches.map(x => x.expiresAt.getTime())))) : undefined
        if (target) {
          // The deal's own opportunity: revised (REPLACE) or added to (ADD).
          // The holds are already linked to it, so Salesforce's push back of
          // the LED fields is an echo (lib/sfdcIntegration.ts trucksToMirror).
          const applied = await applyBookingToOpportunity({
            opp: target,
            mode: reviseKey ? 'REPLACE' : 'ADD',
            booking: {
              amount: quote.summary.grandTotal,
              markets: oppMarkets,
              trucks: truckNumbers,
              ...(quoteOnly || stretches.length === 0 ? {} : { holdStart: starts[0], holdStop: ends[ends.length - 1], holdExp }),
              description,
            },
            by: (token.name as string | undefined) || (token.email as string | undefined) || 'the app',
            primaryContactId: body.primaryContactId,
            clientType: chosenClientType(body.clientType) ?? undefined,
            // What the revised booking added to the opportunity, to take back off.
            ...(reviseKey ? { was: {
              amount: summarizeBooking(reviseHolds.map(h => ({ ...h, expires_at: null }))).total,
              markets: [...new Set(reviseHolds.map(h => h.market))],
            } } : {}),
          })
            if (applied.ok) sfdcOpportunityId = target.Id
          else sfdcError = 'Salesforce rejected the opportunity update'
          if (applied.ok && applied.amountLeft) sfdcWarnings.push(AMOUNT_LEFT_NOTE)
          if (applied.ok && applied.windowLeft) sfdcWarnings.push(WINDOW_LEFT_NOTE)
          if (applied.ok && applied.clientTypeLeft) sfdcWarnings.push(CLIENT_TYPE_LEFT_NOTE)
        } else {
        // Owned by the rep who booked it (matched by email), else the account owner.
        const accountInfo = await getSfdcAccountInfo(body.sfdcAccountId, { withWon: !oppType.opportunityType }).catch(() => null)
        const owner = await resolveOpportunityOwner({ creatorEmail: token.email as string | undefined, accountOwnerId: accountInfo?.ownerId })
        const result = await createAppOpportunity({
          accountId: body.sfdcAccountId,
          ownerId: owner.ownerId ?? undefined,
          // The type the quote was priced as (the seller's pick, else the account's).
          clientType: quote.clientType ?? accountInfo?.clientType,
          leadSource: leadSource ?? undefined,
          // As picked (the planner asks for one whenever a new opportunity is made), else Existing Client once the account has won a deal.
          opportunityType: oppType.opportunityType ?? suggestedOpportunityType(accountInfo?.hasWon),
          name: opportunityName(brand, accountName, `Multi-market (${quote.summary.markets} markets) - ${starts[0]} to ${ends[ends.length - 1]}`),
          brand: brand || undefined,
          primaryContactId: body.primaryContactId,
          stageName: openStage(body.stage),
          closeDate: starts[0],
          amount: quote.summary.grandTotal,
          market: fitNames(oppMarkets, 255),
          // Quote only: no LED truck / hold fields — Salesforce would turn them
          // back into reservations. The trucks priced are in the Description.
          ...(quoteOnly || stretches.length === 0 ? {} : {
            holdStart: starts[0],
            holdStop: ends[ends.length - 1],
            holdExp,
            truckNumbers,
          }),
          activationNotes: `Multi-market: ${quote.lines.length} market${quote.lines.length === 1 ? '' : 's'} booked, ${money(quote.summary.grandTotal)}.`
            + (notSelected.length ? ` ${notSelected.length} quoted but not selected.` : '')
            + (unavailable.length ? ` ${unavailable.length} quoted but no truck available.` : '')
            + (quote.studies.salesLiftRequested ? ' Sales lift requested: the team quotes it.' : '')
            + ' Breakdown in Description.',
          description,
        }, { createdBy, path: 'multi-market' })
        if (result.success && result.id) {
          sfdcOpportunityId = result.id
          sfdcWarnings.push(...(result.warnings ?? []))
          await prisma.hold.updateMany({ where: { campaign_group_id: { startsWith: groupPrefix } }, data: { sfdc_opportunity_id: result.id } })
        } else {
          sfdcError = 'Salesforce rejected the opportunity'
          console.error('[plan/hold] SFDC opportunity creation failed:', result.errors)
        }
        }
      } catch (err) {
        sfdcError = 'Salesforce could not be reached'
        console.error('[plan/hold] SFDC opportunity creation error:', err)
      }
    }

    // Transport and deal-value metrics (best-effort; never fails the booking).
    // Reserving a quote-only log is the first real booking (bookingEvent).
    const revisesBooking = bookingEvent(reviseKey, reviseHolds) === 'REVISED'
    if (!quoteOnly) await recordBooking({ event: revisesBooking ? 'REVISED' : 'BOOKED', groups: quote.lines.map(l => ({ groupId: groupOf.get(l.id)!, legs: legsFromArrivals(l.arrivals) })), appQuotedTotal: quote.summary.grandTotal, createdBy, ...(revisesBooking ? { revised: { holdIds: reviseIds, bookingKey: reviseKey! } } : {}) })

    const leftOut = notSelected.length + unavailable.length
    // Which opportunity, and what happened to it.
    const oppDone = !target ? 'Salesforce opportunity created'
      : reviseKey ? 'Salesforce opportunity updated with the revision'
      : `Added to Salesforce opportunity "${target.Name}"`
    const lead = reviseKey ? 'Booking revised: ' : ''
    const checkIt = sfdcOpportunityId && sfdcWarnings.length ? ` Check it: ${sfdcWarnings.join('; ')}.` : ''
    // What the rep does when Salesforce wasn't updated: an existing opportunity
    // is updated by hand (creating one would duplicate it); otherwise one is created.
    const existingOpp = target ?? (attachUnreachable ? { Name: 'the opportunity you picked' } : null)
    // Writes off (UAT): Salesforce wasn't asked, and is production's org, so
    // there's nothing to do there by hand (an unreachable attach included). Say
    // so, as part of the confirmation rather than as a failure whose modal asks
    // the rep to fix it in Salesforce.
    // Writes stopped on production (SFDC_WRITES=off): the rep still fixes it
    // by hand, but is told why rather than that Salesforce rejected it.
    const refused = !sfdcOpportunityId && !!sfdcError && salesforceWritesOff()
    const writesOff = refused && readOnlyPreview()
    if (refused && !writesOff) sfdcError = WRITES_STOPPED_ERROR
    const fixByHand = existingOpp
      ? ` Update ${target ? `"${target.Name}"` : existingOpp.Name} in Salesforce by hand with this booking (holds grouped under ${groupPrefix}*).`
      : ` Create the opportunity by hand (holds grouped under ${groupPrefix}*).`
    const booked = quoteOnly
      ? `Quote logged for ${accountName} across ${quote.summary.markets} market${quote.summary.markets === 1 ? '' : 's'} (${money(quote.summary.grandTotal)}); no trucks reserved.`
      : `${lead}Placed ${rows.length} hold${rows.length === 1 ? '' : 's'} on ${truckNumbers.length} truck${truckNumbers.length === 1 ? '' : 's'} across ${quote.summary.markets} market${quote.summary.markets === 1 ? '' : 's'} for ${accountName} (${money(quote.summary.grandTotal)})`
        // One lapse date for the whole booking, and why when the start cut it short.
        + (bookingExpiry ? `, held until ${HELD_UNTIL.format(bookingExpiry.expiresAt)}`
          + (bookingExpiry.cappedByStart ? ` (${STAFF_MIN_DAYS_BEFORE_START} days before the first market starts, ${bookingExpiry.startDate}: the latest a booking can be held)`
            : bookingExpiry.atMinimum ? ' (the 24-hour minimum: the first market starts too soon for a longer hold)' : '') : '')
        + '.'
    const sfdcDone = writesOff ? ` ${WRITES_OFF_MESSAGE}`
      : !sfdcOpportunityId ? ''
      : quoteOnly ? ` ${oppDone}.` + checkIt
      : ` ${oppDone}` + (leftOut ? ', with the markets not booked listed in its Description.' : '.') + checkIt
    const sfdcFailure = sfdcOpportunityId || !sfdcError || writesOff ? null
      : quoteOnly ? `${sfdcError}.${fixByHand}` : `${sfdcError}; the holds are placed.${fixByHand}`
    return NextResponse.json({
      ok: true,
      created: stretches.map(x => ({ truckNumber: x.truckNumber, market: x.stint.market, start: x.stint.start, end: x.stint.end })),
      campaignGroupPrefix: groupPrefix,
      sfdcOpportunityId,
      bookedTotal: quote.summary.grandTotal,
      quoteOnly,
      message: booked + (sfdcFailure ? ` ${sfdcFailure}` : sfdcDone),
      // The UI shows the booking and a Salesforce failure apart, so a failure
      // can't read as part of a success.
      confirmation: booked + sfdcDone,
      sfdcFailure,
    })
  } catch (err) {
    console.error('[plan/hold] failed:', err)
    return NextResponse.json({
      error: `Booking stopped before it finished. The holds are written in one transaction, so none were placed by this attempt unless it reports them on retry. Retrying is safe (request ${body.requestId}).`,
    }, { status: 500 })
  }
}

// Every run is logged for the Usage page (lib/usageLog.ts).
export const POST = withUsageLog('hold_multi', 'staff', handlePost)

/** When a hold lapses, as the rep reads it (Central time). */
const HELD_UNTIL = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago', timeZoneName: 'short' })

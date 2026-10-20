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
import { cleanBrand, opportunityName } from '@/lib/brand'
import { QUOTE_ONLY_GROUP_PREFIX, QUOTE_ONLY_NO_TRUCK, QUOTE_ONLY_NOTE, QUOTE_ONLY_ORIGINATION, QUOTE_ONLY_STATUS } from '@/lib/quoteOnly'
import { openStage } from '@/lib/sfdcStages'
import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere } from '@/lib/holdFilters'
import { canonicalMarketName } from '@/lib/marketBounds'
import { holdExpiry, parseHoldDays, MAX_HOLD_DAYS } from '@/lib/holdExpiry'
import { createOpportunity, getSfdcAccountInfo, isSfdcConfigured, checkPrimaryContact, resolveOpportunityOwner } from '@/lib/salesforceClient'
import { loadBookingHolds } from '@/lib/bookingLoad'
import { reviseRefusal, summarizeBooking } from '@/lib/bookings'
import { AMOUNT_LEFT_NOTE, WINDOW_LEFT_NOTE, applyBookingToOpportunity, getBookingOpportunity, opportunityRefusal, reopenClosedLostOpportunity, type BookingOpportunity } from '@/lib/sfdcBooking'
import { SFDC_SERVICE_USER_EMAIL, attachedToOpportunity, reactivationDecision, reopenQuestion } from '@/lib/sfdcIntegration'
import { rotationStints, type OrderLine } from '@/lib/planning/order'
import { buildMultiMarketQuote, resolveRows, validateQuoteRequest, type LineQuote, type QuoteRequest } from '@/lib/planning/quote'
import { fitNames, lineFeatures } from '@/lib/planning/booking'

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
  /** Low conviction: log a priced opportunity, reserve nothing (lib/quoteOnly.ts). */
  quoteOnly?: boolean
  /** The opportunity's primary contact: a Contact on the account. Required. */
  primaryContactId?: string
  /** How long to hold the trucks, in days (default 3, at most MAX_HOLD_DAYS). */
  holdDays?: number
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

const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
const scheduleText = (dpw: number) => (dpw === 3 ? '3 days/wk' : dpw === 7 ? 'every day' : dpw === 6 ? 'Mon-Sat' : 'Mon-Fri')
/** A booked market as delivered: real working dates and days, with the request when it differs. */
const describe = (l: LineQuote, trucks = l.trucks) => {
  const d = l.delivery
  const base = `${l.market}: ${trucks} truck${trucks === 1 ? '' : 's'}, ${scheduleText(l.daysPerWeek)} x ${l.hours}h`
  if (!d.firstDay || !d.lastDay) return `${base}, requested ${l.startDate} to ${l.endDate}`
  const pw = d.partialWeek
  return `${base}, ${d.firstDay} to ${d.lastDay}`
    + (d.firstDay !== l.startDate || d.lastDay !== l.endDate ? ` (requested ${l.startDate} to ${l.endDate})` : '')
    + `, ${d.days} ${trucks > 1 ? 'truck-days' : 'days'}`
    + (pw ? ` (${d.fullWeeks} wk: ${d.fullWeekDays} + part-week ${pw.start} to ${pw.end}: ${pw.days})` : '')
}
/** A market quoted but not booked: the request as quoted. */
const describeQuoted = (l: LineQuote, trucks = l.trucks) =>
  `${l.market}: ${trucks} truck${trucks === 1 ? '' : 's'}, ${l.startDate} to ${l.endDate}, ${scheduleText(l.daysPerWeek)} x ${l.hours}h`

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
  // Holds never displace AT&T: soft-hold trucks are always reserved here.
  body.reserveSoftHolds = true
  const invalid = validateQuoteRequest(body)
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })

  const quoteOnly = body.quoteOnly === true
  // Quote-only logs and real bookings live in separate id spaces, so a real
  // booking can never be mistaken for an earlier quote-only log of the same
  // quote (or the reverse) and answered "already placed" with nothing held.
  const groupPrefix = `${quoteOnly ? QUOTE_ONLY_GROUP_PREFIX : 'mm_'}${body.requestId}_`

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
      // Book what can be covered: drop the uncovered trucks and route again,
      // so the holds and the amount are for exactly what is booked.
      let lines: OrderLine[] = chosen
      for (let round = 0; round < 3 && booking.plan.shortfalls.length > 0; round++) {
        const missing = new Map(booking.plan.shortfalls.map(s => [s.lineId, s.missing]))
        lines = lines.map(l => ({ ...l, trucks: l.trucks - (missing.get(l.id) ?? 0) })).filter(l => l.trucks > 0)
        if (lines.length === 0) break
        booking = await buildMultiMarketQuote(body, lines, { alternatives: false })
      }
      if (booking.plan.shortfalls.length > 0 || booking.plan.trucks.length === 0) {
        return NextResponse.json({ error: 'No trucks can be assigned to the selected markets right now.' }, { status: 409 })
      }
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
    const orderLine = new Map(plan.trucks.flatMap(t => t.jobs.flatMap(j => j.lines)).map(l => [l.id, l]))
    const place = new Map<string, { market: string; state: string }>()
    for (const l of quote.lines) {
      const name = orderLine.get(l.id)?.standardMarket ?? l.market
      const state = name.split(',')[1]?.trim() ?? ''
      place.set(l.id, { market: (await canonicalMarketName(name, state || undefined)) ?? name, state })
    }
    // One clock for every hold, so equal lengths give equal expiries (the
    // confirmation compares them to say whether markets lapse at different times).
    const holdClock = new Date()
    // Added to an existing opportunity, now or when the revised booking was:
    // its holds lapsing must not close that deal (expiryClosesOpportunity).
    const attached = !!target && (!!body.attachOpportunityId || reviseHolds.some(h => attachedToOpportunity(h.features)))
    const withAttach = <T extends object>(f: T) => (attached ? { ...f, attachedToOpportunity: true } : f)
    // A revised market keeps what ops already gave its live holds: committed
    // stays committed, and an expiry they extended is never cut back.
    const sameMarket = (m: string) => m.trim().toLowerCase()
    const replaced = new Map<string, { committed: boolean; latest: Date | null }>()
    for (const h of reviseHolds.filter(x => x.live)) {
      const k = sameMarket(h.market)
      const was = replaced.get(k) ?? { committed: false, latest: null }
      replaced.set(k, {
        committed: was.committed || h.status === 'COMMITTED',
        latest: h.expires_at && (!was.latest || h.expires_at > was.latest) ? h.expires_at : was.latest,
      })
    }
    const keptExpiry = (lineId: string, computed: Date) => {
      const latest = replaced.get(sameMarket(place.get(lineId)!.market))?.latest
      return latest && latest > computed ? latest : computed
    }
    const committedMarket = (lineId: string) => replaced.get(sameMarket(place.get(lineId)!.market))?.committed === true
    const stretches = plan.trucks.flatMap(t => t.jobs.flatMap(job => rotationStints(job).map(st => ({
      truckNumber: t.truckNumber,
      stint: st,
      partner: job.lines.length > 1 ? job.lines.find(l => l.id !== st.lineId)!.market : null,
      // Each market's hold runs the seller's length, cut by its own start date,
      // or the later expiry its replaced holds already had.
      expiresAt: keptExpiry(st.lineId, holdExpiry(job.start, holdDays, holdClock).expiresAt),
    }))))

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
    const brand = cleanBrand(body.brand)
    const linkedClient = await prisma.clientUser.findFirst({ where: { sfdc_account_id: body.sfdcAccountId }, select: { id: true } })
    const serviceUser = await prisma.user.findFirst({ where: { email: SFDC_SERVICE_USER_EMAIL }, select: { id: true } })
    const createdBy = (token.id as string) || serviceUser?.id || 'system'
    const tier = body.features.shadowFencing && !body.features.smartDirectional && !body.features.deviceId
      ? 'Better' : !body.features.shadowFencing && !body.features.smartDirectional && !body.features.deviceId ? 'Good' : 'Custom'
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
        features: JSON.stringify(withAttach(lineFeatures(lq, body.features, quote.brandMarkupPct))),
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
        // A won opportunity's booking, or a market ops marked committed, stays committed through a revision.
        status: target?.IsWon || committedMarket(stint.lineId) ? 'COMMITTED' : 'HOLD',
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
        features: JSON.stringify(withAttach(lineFeatures(lq, body.features, quote.brandMarkupPct))),
        truck_count: lq.trucks,
        campaign_group_id: groupOf.get(stint.lineId)!,
        expires_at: target?.IsWon || committedMarket(stint.lineId) ? null : expiresAt,
        sfdc_opportunity_id: target?.Id ?? null,
      }
    })
    const CHUNK = 200
    // The revision's audit row is the only record of the booking it replaces
    // (the old holds are deleted), so it carries every column of every old
    // hold and is written in the same transaction as the delete: the record,
    // the delete and the new holds land together, or none of them do.
    const was = reviseIds.length ? await prisma.hold.findMany({ where: { id: { in: reviseIds } } }) : []
    // A Closed Lost opportunity the person agreed to reopen: moved back to
    // WARM last, after every check that could still refuse, so a revision that
    // stops above never reopens the deal. If Salesforce refuses, nothing here
    // changes.
    let reopened: { fromStage: string; toStage: string } | null = null
    if (reviseKey && target && body.reopenOpportunity === true && target.IsClosed && !target.IsWon) {
      const r = await reopenClosedLostOpportunity(target.Id)
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 })
      reopened = r
      target = { ...target, StageName: r.toStage, IsClosed: false }
    }
    await prisma.$transaction([
      ...(reopened ? [prisma.auditLog.create({
        data: {
          action: 'REOPEN_OPPORTUNITY',
          truck_number: truckNumbers[0] ?? reviseHolds[0]?.truck_number ?? '',
          user_id: createdBy,
          details: JSON.stringify({
            opportunity_id: target!.Id, from_stage: reopened.fromStage, to_stage: reopened.toStage,
            by: (token.email as string | undefined) ?? createdBy, for: 'REVISE_BOOKING', booking: reviseKey,
          }),
        },
      })] : []),
      ...(reviseKey ? [prisma.auditLog.create({
        data: {
          action: 'REVISE_BOOKING',
          truck_number: truckNumbers[0] ?? reviseHolds[0]?.truck_number ?? '',
          user_id: createdBy,
          details: JSON.stringify({
            booking: reviseKey, now: groupPrefix.replace(/_$/, ''), opportunity: target?.Id ?? null,
            was, trucks: truckNumbers, total: quote.summary.grandTotal,
          }),
        },
      })] : []),
      ...(reviseIds.length ? [prisma.hold.deleteMany({ where: { id: { in: reviseIds } } })] : []),
      ...Array.from({ length: Math.ceil(rows.length / CHUNK) }, (_, i) =>
        prisma.hold.createMany({ data: rows.slice(i * CHUNK, (i + 1) * CHUNK) })),
    ])

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
          ...quote.lines.map(l => `${describe(l)}, ${money(l.total)}`),
          ...(notSelected.length ? ['', 'Quoted but not selected:', ...notSelected.map(l => `${describeQuoted(l)}, ${money(l.total)}`)] : []),
          ...(unavailable.length ? ['', 'Quoted but no truck available:', ...unavailable] : []),
        ].join('\n')
        const holdExp = stretches.length ? new Date(Math.min(...stretches.map(x => x.expiresAt.getTime()))).toISOString().split('T')[0] : undefined
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
        } else {
        // Owned by the rep who booked it (matched by email), else the account owner.
        const accountInfo = await getSfdcAccountInfo(body.sfdcAccountId).catch(() => null)
        const owner = await resolveOpportunityOwner({ creatorEmail: token.email as string | undefined, accountOwnerId: accountInfo?.ownerId })
        const result = await createOpportunity({
          accountId: body.sfdcAccountId,
          ownerId: owner.ownerId ?? undefined,
          clientType: accountInfo?.clientType,
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
            + ' Breakdown in Description.',
          description,
        })
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
    const fixByHand = existingOpp
      ? ` Update ${target ? `"${target.Name}"` : existingOpp.Name} in Salesforce by hand with this booking (holds grouped under ${groupPrefix}*).`
      : ` Create the opportunity by hand (holds grouped under ${groupPrefix}*).`
    const booked = quoteOnly
      ? `Quote logged for ${accountName} across ${quote.summary.markets} market${quote.summary.markets === 1 ? '' : 's'} (${money(quote.summary.grandTotal)}); no trucks reserved.`
      : `${lead}Placed ${rows.length} hold${rows.length === 1 ? '' : 's'} on ${truckNumbers.length} truck${truckNumbers.length === 1 ? '' : 's'} across ${quote.summary.markets} market${quote.summary.markets === 1 ? '' : 's'} for ${accountName} (${money(quote.summary.grandTotal)})`
        + (target?.IsWon ? ', committed (the opportunity is won)' : stretches.length ? `, held until ${HELD_UNTIL.format(new Date(Math.min(...stretches.map(x => x.expiresAt.getTime()))))}` : '')
        + (!target?.IsWon && stretches.some(x => x.expiresAt.getTime() !== stretches[0].expiresAt.getTime()) ? ' (some markets lapse later: see each on Reservations)' : '') + '.'
    const sfdcDone = !sfdcOpportunityId ? ''
      : quoteOnly ? ` ${oppDone}.` + checkIt
      : ` ${oppDone}` + (leftOut ? ', with the markets not booked listed in its Description.' : '.') + checkIt
    const sfdcFailure = sfdcOpportunityId || !sfdcError ? null
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

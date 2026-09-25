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

import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere } from '@/lib/holdFilters'
import { canonicalMarketName } from '@/lib/marketBounds'
import { computeHoldExpiresAt } from '@/lib/holdExpiry'
import { createOpportunity, isSfdcConfigured } from '@/lib/salesforceClient'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'
import { rotationStints, type OrderLine } from '@/lib/planning/order'
import { buildMultiMarketQuote, resolveRows, validateQuoteRequest, type LineQuote, type QuoteRequest } from '@/lib/planning/quote'
import { fitNames, lineFeatures } from '@/lib/planning/booking'

export const maxDuration = 300

type HoldBody = QuoteRequest & {
  sfdcAccountName?: string
  /** Row ids to book. Omitted: every row. */
  selectedIds?: string[]
  /** Book what can be covered when some trucks no longer can be. */
  allowPartial?: boolean
  /** One id per booking attempt; a retry with the same id returns the first result. */
  requestId?: string
  /** The total the rep saw for the selected markets; booking stops if the fresh price differs. */
  expectedTotal?: number
}

const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
const scheduleText = (dpw: number) => (dpw === 3 ? '3 days/wk' : dpw === 7 ? 'every day' : dpw === 6 ? 'Mon-Sat' : 'Mon-Fri')
const describe = (l: LineQuote, trucks = l.trucks) =>
  `${l.market}: ${trucks} truck${trucks === 1 ? '' : 's'}, ${l.startDate} to ${l.endDate}, ${scheduleText(l.daysPerWeek)} x ${l.hours}h`

export async function POST(req: NextRequest) {
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
  body.features = body.features ?? { shadowFencing: true, smartDirectional: false, deviceId: false }
  // Holds never displace AT&T: soft-hold trucks are always reserved here.
  body.reserveSoftHolds = true
  const invalid = validateQuoteRequest(body)
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })

  const groupPrefix = `mm_${body.requestId}_`

  try {
    // A retry of an attempt that already booked: return what it booked.
    const earlier = await prisma.hold.findMany({
      where: { campaign_group_id: { startsWith: groupPrefix } },
      select: { truck_number: true, market: true, start_date: true, end_date: true, sfdc_opportunity_id: true },
    })
    if (earlier.length > 0) {
      const trucks = new Set(earlier.map(h => h.truck_number)).size
      return NextResponse.json({
        ok: true,
        alreadyPlaced: true,
        created: earlier.map(h => ({ truckNumber: h.truck_number, market: h.market, start: h.start_date.toISOString().slice(0, 10), end: h.end_date.toISOString().slice(0, 10) })),
        sfdcOpportunityId: earlier.find(h => h.sfdc_opportunity_id)?.sfdc_opportunity_id ?? null,
        message: `These holds were already placed: ${earlier.length} holds on ${trucks} truck${trucks === 1 ? '' : 's'}. Nothing new was booked.`,
      })
    }

    const { lines: allLines, errors } = await resolveRows(body.rows)
    if (errors.length) return NextResponse.json({ error: 'Some markets need attention.', rowErrors: errors }, { status: 400 })
    const selected = new Set(body.selectedIds ?? allLines.map(l => l.id))
    const chosen = allLines.filter(l => selected.has(l.id))
    if (chosen.length === 0) return NextResponse.json({ error: 'Select at least one market to book.' }, { status: 400 })

    // Route the selected markets from fresh data.
    let booking = await buildMultiMarketQuote(body, chosen, { alternatives: false })
    const asQuoted = booking.quote
    if (booking.plan.shortfalls.length > 0) {
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
    const stretches = plan.trucks.flatMap(t => t.jobs.flatMap(job => rotationStints(job).map(st => ({
      truckNumber: t.truckNumber,
      stint: st,
      partner: job.lines.length > 1 ? job.lines.find(l => l.id !== st.lineId)!.market : null,
      expiresAt: computeHoldExpiresAt(job.start),
    }))))

    // All or nothing: any stretch that now clashes stops the whole booking.
    const truckNumbers = [...new Set(stretches.map(x => x.truckNumber))]
    const from = stretches.reduce((m, x) => (x.stint.start < m ? x.stint.start : m), stretches[0].stint.start)
    const to = stretches.reduce((m, x) => (x.stint.end > m ? x.stint.end : m), stretches[0].stint.end)
    const existing = await prisma.hold.findMany({
      where: {
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
    const linkedClient = await prisma.clientUser.findFirst({ where: { sfdc_account_id: body.sfdcAccountId }, select: { id: true } })
    const serviceUser = await prisma.user.findFirst({ where: { email: SFDC_SERVICE_USER_EMAIL }, select: { id: true } })
    const createdBy = (token.id as string) || serviceUser?.id || 'system'
    const tier = body.features.shadowFencing && !body.features.smartDirectional && !body.features.deviceId
      ? 'Better' : !body.features.shadowFencing && !body.features.smartDirectional && !body.features.deviceId ? 'Good' : 'Custom'
    // One campaign group per market, so each market reads as its own campaign
    // with its own total wherever holds are grouped.
    const groupOf = new Map(quote.lines.map((l, i) => [l.id, `${groupPrefix}${i + 1}`]))

    const rows: Prisma.HoldCreateManyInput[] = stretches.map(({ truckNumber, stint, partner, expiresAt }) => {
      const lq = lineById.get(stint.lineId)!
      const where = place.get(stint.lineId)!
      return {
        truck_number: truckNumber,
        client_name: accountName,
        market: where.market,
        state: where.state,
        start_date: new Date(stint.start),
        end_date: new Date(stint.end),
        status: 'HOLD',
        source: 'INTERNAL',
        origination: 'frontend',
        notes: `${lq.market}, part of a ${quote.summary.markets}-market order for ${accountName}.`
          + (partner ? ` Truck alternates weekly with ${partner}.` : '')
          + (stint.travelTo ? ` Last day is travel to ${stint.travelTo}.` : ''),
        created_by: createdBy,
        client_user_id: linkedClient?.id ?? null,
        pricing_tier: tier,
        quoted_total: lq.total,
        daily_rate: lq.effectiveDailyRate,
        features: JSON.stringify(lineFeatures(lq, body.features)),
        truck_count: lq.trucks,
        campaign_group_id: groupOf.get(stint.lineId)!,
        expires_at: expiresAt,
      }
    })
    const CHUNK = 200
    await prisma.$transaction(Array.from({ length: Math.ceil(rows.length / CHUNK) }, (_, i) =>
      prisma.hold.createMany({ data: rows.slice(i * CHUNK, (i + 1) * CHUNK) })))

    // What was quoted and is not being booked, for the opportunity's notes.
    const bookedTrucks = new Map(quote.lines.map(l => [l.id, l.trucks]))
    const unavailable = asQuoted.lines
      .filter(l => (bookedTrucks.get(l.id) ?? 0) < l.trucks)
      .map(l => describe(l, l.trucks - (bookedTrucks.get(l.id) ?? 0)))
    const notSelected = allLines.some(l => !selected.has(l.id))
      ? (await buildMultiMarketQuote(body, allLines, { alternatives: false })).quote.lines.filter(l => !selected.has(l.id))
      : []

    let sfdcOpportunityId: string | null = null
    let sfdcError: string | null = null
    if (isSfdcConfigured()) {
      try {
        const starts = quote.lines.map(l => l.startDate).sort()
        const ends = quote.lines.map(l => l.endDate).sort()
        const description = [
          'Booked:',
          ...quote.lines.map(l => `${describe(l)}, ${money(l.total)}`),
          ...(notSelected.length ? ['', 'Quoted but not selected:', ...notSelected.map(l => `${describe(l)}, ${money(l.total)}`)] : []),
          ...(unavailable.length ? ['', 'Quoted but no truck available:', ...unavailable] : []),
        ].join('\n')
        const result = await createOpportunity({
          accountId: body.sfdcAccountId,
          name: `${accountName} - Multi-market (${quote.summary.markets} markets) - ${starts[0]} to ${ends[ends.length - 1]}`.slice(0, 120),
          stageName: 'WARM',
          closeDate: starts[0],
          amount: quote.summary.grandTotal,
          market: fitNames(quote.lines.map(l => l.market), 255),
          holdStart: starts[0],
          holdStop: ends[ends.length - 1],
          holdExp: new Date(Math.min(...stretches.map(x => x.expiresAt.getTime()))).toISOString().split('T')[0],
          truckNumbers,
          activationNotes: `Multi-market: ${quote.lines.length} market${quote.lines.length === 1 ? '' : 's'} booked, ${money(quote.summary.grandTotal)}.`
            + (notSelected.length ? ` ${notSelected.length} quoted but not selected.` : '')
            + (unavailable.length ? ` ${unavailable.length} quoted but no truck available.` : '')
            + ' Breakdown in Description.',
          description,
        })
        if (result.success && result.id) {
          sfdcOpportunityId = result.id
          await prisma.hold.updateMany({ where: { campaign_group_id: { startsWith: groupPrefix } }, data: { sfdc_opportunity_id: result.id } })
        } else {
          sfdcError = 'Salesforce rejected the opportunity'
          console.error('[plan/hold] SFDC opportunity creation failed:', result.errors)
        }
      } catch (err) {
        sfdcError = 'Salesforce could not be reached'
        console.error('[plan/hold] SFDC opportunity creation error:', err)
      }
    }

    const leftOut = notSelected.length + unavailable.length
    return NextResponse.json({
      ok: true,
      created: stretches.map(x => ({ truckNumber: x.truckNumber, market: x.stint.market, start: x.stint.start, end: x.stint.end })),
      campaignGroupPrefix: groupPrefix,
      sfdcOpportunityId,
      bookedTotal: quote.summary.grandTotal,
      message: `Placed ${rows.length} hold${rows.length === 1 ? '' : 's'} on ${truckNumbers.length} truck${truckNumbers.length === 1 ? '' : 's'} across ${quote.summary.markets} market${quote.summary.markets === 1 ? '' : 's'} for ${accountName} (${money(quote.summary.grandTotal)}).`
        + (sfdcOpportunityId ? ' Salesforce opportunity created' + (leftOut ? ', with the markets not booked listed in its Description.' : '.')
          : sfdcError ? ` ${sfdcError}; the holds are placed. Create the opportunity by hand (holds grouped under ${groupPrefix}*).` : ''),
    })
  } catch (err) {
    console.error('[plan/hold] failed:', err)
    return NextResponse.json({
      error: `Booking stopped before it finished. The holds are written in one transaction, so none were placed by this attempt unless it reports them on retry. Retrying is safe (request ${body.requestId}).`,
    }, { status: 500 })
  }
}

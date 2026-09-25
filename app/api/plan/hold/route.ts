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
 * Partial bookings. Markets the rep did not select, and trucks the fleet can
 * no longer cover (booked only when the rep confirms), are left out of the
 * holds and the opportunity amount, and listed in the opportunity's notes as
 * quoted but not booked.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere } from '@/lib/holdFilters'
import { canonicalMarketName } from '@/lib/marketBounds'
import { computeHoldExpiresAt } from '@/lib/holdExpiry'
import { createOpportunity, isSfdcConfigured } from '@/lib/salesforceClient'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'
import { rotationStints, type OrderLine } from '@/lib/planning/order'
import { buildMultiMarketQuote, resolveRows, validateQuoteRequest, type LineQuote, type QuoteRequest } from '@/lib/planning/quote'

export const maxDuration = 300

type HoldBody = QuoteRequest & {
  sfdcAccountName?: string
  /** Row ids to book. Omitted: every row. */
  selectedIds?: string[]
  /** Book what can be covered when some trucks no longer can be. */
  allowPartial?: boolean
}

const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
const describe = (l: LineQuote, trucks = l.trucks) =>
  `${l.market}: ${trucks} truck${trucks === 1 ? '' : 's'}, ${l.startDate} to ${l.endDate}, ${l.daysPerWeek === 3 ? '3 days/wk' : l.daysPerWeek === 7 ? 'every day' : l.daysPerWeek === 6 ? 'Mon-Sat' : 'Mon-Fri'} x ${l.hours}h`

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
  body.features = body.features ?? { shadowFencing: true, smartDirectional: false, deviceId: false }
  // Holds never displace AT&T: soft-hold trucks are always reserved here.
  body.reserveSoftHolds = true
  const invalid = validateQuoteRequest(body)
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })

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
        quote: asQuoted,
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

  // What was quoted and is not being booked, for the opportunity's notes.
  const bookedTrucks = new Map(quote.lines.map(l => [l.id, l.trucks]))
  const unavailable = asQuoted.lines
    .filter(l => (bookedTrucks.get(l.id) ?? 0) < l.trucks)
    .map(l => describe(l, l.trucks - (bookedTrucks.get(l.id) ?? 0)))
  const notSelected = allLines.some(l => !selected.has(l.id))
    ? (await buildMultiMarketQuote(body, allLines, { alternatives: false })).quote.lines.filter(l => !selected.has(l.id))
    : []

  const accountName = body.sfdcAccountName || 'Client'
  const campaignGroupId = `cg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const linkedClient = await prisma.clientUser.findFirst({ where: { sfdc_account_id: body.sfdcAccountId }, select: { id: true } })
  const serviceUser = await prisma.user.findFirst({ where: { email: SFDC_SERVICE_USER_EMAIL }, select: { id: true } })
  const createdBy = (token.id as string) || serviceUser?.id || 'system'
  const tier = body.features.shadowFencing && !body.features.smartDirectional && !body.features.deviceId
    ? 'Better' : !body.features.shadowFencing && !body.features.smartDirectional && !body.features.deviceId ? 'Good' : 'Custom'
  const lineById = new Map(quote.lines.map(l => [l.id, l]))
  const canonical = new Map<string, { market: string; state: string }>()
  for (const l of quote.lines) {
    const state = l.market.split(',')[1]?.trim() ?? ''
    canonical.set(l.id, { market: (await canonicalMarketName(l.market, state || undefined)) ?? l.market, state })
  }

  const created: { truckNumber: string; market: string; start: string; end: string }[] = []
  const skipped: { truckNumber: string; market: string; start: string; end: string; reason: string }[] = []
  const expiries: Date[] = []

  for (const t of plan.trucks) {
    for (const job of t.jobs) {
      const partner = job.lines.length > 1 ? job.lines.map(l => l.market) : null
      const expiresAt = computeHoldExpiresAt(job.start)
      for (const stint of rotationStints(job)) {
        const clash = await prisma.hold.findFirst({
          where: {
            truck_number: t.truckNumber,
            ...activeHoldWhere({ excludeAttSoft: true }),
            start_date: { lte: new Date(stint.end) },
            end_date: { gte: new Date(stint.start) },
          },
          select: { id: true },
        })
        if (clash) {
          skipped.push({ truckNumber: t.truckNumber, market: stint.market, start: stint.start, end: stint.end, reason: 'booked since the quote was built' })
          continue
        }
        const where = canonical.get(stint.lineId)!
        const lq = lineById.get(stint.lineId)
        expiries.push(expiresAt)
        await prisma.hold.create({
          data: {
            truck_number: t.truckNumber,
            client_name: accountName,
            market: where.market,
            state: where.state,
            start_date: new Date(stint.start),
            end_date: new Date(stint.end),
            status: 'HOLD',
            source: 'INTERNAL',
            origination: 'frontend',
            notes: `Multi-market quote for ${accountName} (${quote.summary.markets} markets).`
              + (partner ? ` Truck alternates weekly between ${partner.join(' and ')}.` : '')
              + (stint.travelTo ? ` Last day is travel to ${stint.travelTo}.` : ''),
            created_by: createdBy,
            client_user_id: linkedClient?.id ?? null,
            pricing_tier: tier,
            quoted_total: quote.summary.grandTotal,
            daily_rate: lq?.effectiveDailyRate ?? null,
            features: JSON.stringify({ multiMarket: true, line: lq, sharedWith: partner, order: quote.summary }),
            truck_count: quote.summary.trucksUsed,
            campaign_group_id: campaignGroupId,
            expires_at: expiresAt,
          },
        })
        created.push({ truckNumber: t.truckNumber, market: stint.market, start: stint.start, end: stint.end })
      }
    }
  }

  if (created.length === 0) return NextResponse.json({ error: 'No holds could be placed.', skipped }, { status: 409 })

  let sfdcOpportunityId: string | null = null
  if (isSfdcConfigured()) {
    try {
      const starts = quote.lines.map(l => l.startDate).sort()
      const ends = quote.lines.map(l => l.endDate).sort()
      const markets = quote.lines.map(l => l.market).join('; ')
      const notes = [
        'Booked:',
        ...quote.lines.map(l => `${describe(l)}, ${money(l.total)}`),
        ...(notSelected.length ? ['', 'Quoted but not selected:', ...notSelected.map(l => `${describe(l)}, ${money(l.total)}`)] : []),
        ...(unavailable.length ? ['', 'Quoted but no truck available:', ...unavailable] : []),
        ...(skipped.length ? ['', 'Holds not placed (truck booked since the quote):', ...skipped.map(s => `#${s.truckNumber} ${s.market} ${s.start} to ${s.end}`)] : []),
      ].join('\n')
      const result = await createOpportunity({
        accountId: body.sfdcAccountId,
        name: `${accountName} - Multi-market (${quote.summary.markets} markets) - ${starts[0]} to ${ends[ends.length - 1]}`.slice(0, 120),
        stageName: 'WARM',
        closeDate: starts[0],
        amount: quote.summary.grandTotal,
        market: markets.length > 250 ? markets.slice(0, 247) + '...' : markets,
        holdStart: starts[0],
        holdStop: ends[ends.length - 1],
        holdExp: new Date(Math.min(...expiries.map(d => d.getTime()))).toISOString().split('T')[0],
        truckNumbers: [...new Set(created.map(c => c.truckNumber))],
        activationNotes: `Multi-market: ${quote.lines.length} market${quote.lines.length === 1 ? '' : 's'} booked, ${money(quote.summary.grandTotal)}.`
          + (notSelected.length ? ` ${notSelected.length} quoted but not selected.` : '')
          + (unavailable.length ? ` ${unavailable.length} quoted but no truck available.` : '')
          + ' Breakdown in Description.',
        description: notes,
      })
      if (result.success && result.id) {
        sfdcOpportunityId = result.id
        await prisma.hold.updateMany({ where: { campaign_group_id: campaignGroupId }, data: { sfdc_opportunity_id: result.id } })
      } else {
        console.error('[plan/hold] SFDC opportunity creation failed:', result.errors)
      }
    } catch (err) {
      console.error('[plan/hold] SFDC opportunity creation error:', err)
    }
  }

  const truckCount = new Set(created.map(c => c.truckNumber)).size
  const leftOut = notSelected.length + unavailable.length
  return NextResponse.json({
    ok: true,
    created,
    skipped,
    campaignGroupId,
    sfdcOpportunityId,
    bookedTotal: quote.summary.grandTotal,
    message: `Placed ${created.length} hold${created.length === 1 ? '' : 's'} on ${truckCount} truck${truckCount === 1 ? '' : 's'} across ${quote.summary.markets} market${quote.summary.markets === 1 ? '' : 's'} for ${accountName} (${money(quote.summary.grandTotal)}).`
      + (sfdcOpportunityId ? ' Salesforce opportunity created' + (leftOut ? ', with the markets not booked listed in its notes.' : '.') : isSfdcConfigured() ? ' The Salesforce opportunity could not be created; check the server log.' : ''),
  })
}

/**
 * POST /api/plan/hold — place holds for a multi-market order and create one
 * Salesforce opportunity for it.
 *
 * The order is routed again here from fresh data, never from the browser's
 * copy: trucks may have been booked since the quote was shown. Holds are then
 * placed exactly as the fresh plan assigns them.
 *
 * One hold per truck per job. A truck that alternates week to week between two
 * markets gets ONE hold covering both markets' dates, recorded against the
 * market it starts in, with the other named in its notes. Two overlapping holds
 * on one truck would read as a double-booking to the hold checks and the
 * infeasible-hold audit.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere } from '@/lib/holdFilters'
import { canonicalMarketName } from '@/lib/marketBounds'
import { computeHoldExpiresAt } from '@/lib/holdExpiry'
import { createOpportunity, isSfdcConfigured } from '@/lib/salesforceClient'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'
import { buildMultiMarketQuote, resolveRows, validateQuoteRequest, type QuoteRequest } from '@/lib/planning/quote'

export const maxDuration = 300

type HoldBody = QuoteRequest & { sfdcAccountName?: string; allowPartial?: boolean }

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

  const { lines, errors } = await resolveRows(body.rows)
  if (errors.length) return NextResponse.json({ error: 'Some markets need attention.', rowErrors: errors }, { status: 400 })
  const { quote, plan } = await buildMultiMarketQuote(body, lines)

  if (plan.shortfalls.length > 0 && !body.allowPartial) {
    return NextResponse.json({
      error: 'Not every market can be covered right now.',
      shortfalls: plan.shortfalls,
      quote,
    }, { status: 409 })
  }
  if (plan.trucks.length === 0) return NextResponse.json({ error: 'No trucks can be assigned.' }, { status: 409 })

  const accountName = body.sfdcAccountName || 'Client'
  const campaignGroupId = `cg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const linkedClient = await prisma.clientUser.findFirst({ where: { sfdc_account_id: body.sfdcAccountId }, select: { id: true } })
  const serviceUser = await prisma.user.findFirst({ where: { email: SFDC_SERVICE_USER_EMAIL }, select: { id: true } })
  const createdBy = (token.id as string) || serviceUser?.id || 'system'
  const tier = body.features.shadowFencing && !body.features.smartDirectional && !body.features.deviceId
    ? 'Better' : !body.features.shadowFencing && !body.features.smartDirectional && !body.features.deviceId ? 'Good' : 'Custom'
  const lineById = new Map(quote.lines.map(l => [l.id, l]))

  const created: { truckNumber: string; market: string; start: string; end: string }[] = []
  const skipped: { truckNumber: string; market: string; reason: string }[] = []
  const expiries: Date[] = []

  for (const t of plan.trucks) {
    for (const job of t.jobs) {
      const primary = job.first
      const other = job.lines.find(l => l.id !== primary.id)
      const clash = await prisma.hold.findFirst({
        where: {
          truck_number: t.truckNumber,
          ...activeHoldWhere({ excludeAttSoft: true }),
          start_date: { lte: new Date(job.end) },
          end_date: { gte: new Date(job.start) },
        },
        select: { id: true },
      })
      if (clash) { skipped.push({ truckNumber: t.truckNumber, market: primary.market, reason: 'booked since the quote was built' }); continue }

      const state = primary.market.split(',')[1]?.trim() ?? ''
      const market = (await canonicalMarketName(primary.market, state || undefined)) ?? primary.market
      const expiresAt = computeHoldExpiresAt(job.start)
      expiries.push(expiresAt)
      const lq = lineById.get(primary.id)
      await prisma.hold.create({
        data: {
          truck_number: t.truckNumber,
          client_name: accountName,
          market,
          state,
          start_date: new Date(job.start),
          end_date: new Date(job.end),
          status: 'HOLD',
          source: 'INTERNAL',
          origination: 'frontend',
          notes: `Multi-market quote for ${accountName} (${quote.summary.markets} markets).`
            + (other ? ` Alternates weekly with ${other.market} (${other.startDate} to ${other.endDate}).` : ''),
          created_by: createdBy,
          client_user_id: linkedClient?.id ?? null,
          pricing_tier: tier,
          quoted_total: quote.summary.grandTotal,
          daily_rate: lq?.effectiveDailyRate ?? null,
          features: JSON.stringify({
            multiMarket: true,
            lines: job.lines.map(l => lineById.get(l.id)).filter(Boolean),
            order: quote.summary,
          }),
          truck_count: quote.summary.trucksUsed,
          campaign_group_id: campaignGroupId,
          expires_at: expiresAt,
        },
      })
      created.push({ truckNumber: t.truckNumber, market: other ? `${primary.market} + ${other.market}` : primary.market, start: job.start, end: job.end })
    }
  }

  if (created.length === 0) return NextResponse.json({ error: 'No holds could be placed.', skipped }, { status: 409 })

  let sfdcOpportunityId: string | null = null
  if (isSfdcConfigured()) {
    try {
      const starts = quote.lines.map(l => l.startDate).sort()
      const ends = quote.lines.map(l => l.endDate).sort()
      const markets = quote.lines.map(l => l.market).join('; ')
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
        activationNotes: quote.lines
          .map(l => `${l.market}: ${l.trucks} truck${l.trucks === 1 ? '' : 's'}, ${l.startDate} to ${l.endDate}, ${l.daysPerWeek}x${l.hours}, $${l.total.toLocaleString('en-US')}`)
          .join('\n'),
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

  return NextResponse.json({
    ok: true,
    created,
    skipped,
    campaignGroupId,
    sfdcOpportunityId,
    message: `Placed ${created.length} hold${created.length === 1 ? '' : 's'} on ${new Set(created.map(c => c.truckNumber)).size} trucks for ${accountName}.`
      + (sfdcOpportunityId ? ' Salesforce opportunity created.' : isSfdcConfigured() ? ' The Salesforce opportunity could not be created; check the server log.' : ''),
  })
}

/**
 * POST /api/quote/hold
 *
 * Internal hold placement — staff creates a hold on behalf of a client.
 * Requires a sfdc_account_id to create the Salesforce Opportunity.
 * Uses the availability engine to auto-select trucks.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { prisma } from '@/lib/prisma'
import { selectTrucksForHold } from '@/lib/availabilityEngine'
import { computeHoldExpiresAt } from '@/lib/holdRequestService'
import { createOpportunity, isSfdcConfigured } from '@/lib/salesforceClient'
import { parseQuoteFeatures, buildActivationNotes } from '@/lib/quoteFeatures'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'
import { computeQuote, VALID_STUDIES, type StudyType } from '@/lib/pricing'
import { resolveMarketSizeTierId } from '@/lib/pricing/resolvers'

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const {
    market, state, start_date, end_date, truck_count,
    sfdc_account_id, sfdc_account_name,
    shadow_fencing, smart_directional, device_id, studies: rawStudies,
    days_per_week, operating_hours,
  } = body

  if (!market || !start_date || !end_date || !truck_count) {
    return NextResponse.json({ error: 'market, start_date, end_date, truck_count required' }, { status: 400 })
  }

  if (!sfdc_account_id) {
    return NextResponse.json({ error: 'A Salesforce Account must be selected' }, { status: 400 })
  }

  // Select optimal trucks
  const { selectedTrucks } = await selectTrucksForHold({
    market,
    startDate: start_date,
    endDate: end_date,
    truckCount: truck_count,
  })

  if (selectedTrucks.length === 0) {
    return NextResponse.json({ error: 'No trucks available' }, { status: 409 })
  }

  const campaignGroupId = `cg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const resolvedState = state || market.split(',')[1]?.trim() || null
  const expiresAt = computeHoldExpiresAt(start_date)

  // ── Server-side price recomputation ──────────────────────────────────────
  const startDateObj = new Date(start_date + 'T00:00:00Z')
  const endDateObj = new Date(end_date + 'T00:00:00Z')
  const calendarDays = Math.round((endDateObj.getTime() - startDateObj.getTime()) / (1000 * 60 * 60 * 24)) + 1
  const defaultDpw = calendarDays <= 6 ? 7 : 5
  const dpw = days_per_week ?? defaultDpw
  const opHours = operating_hours ?? 8

  let activationDays = calendarDays
  if (dpw < 7) {
    activationDays = 0
    const c = new Date(start_date + 'T00:00:00Z'), e = new Date(end_date + 'T00:00:00Z')
    while (c <= e) {
      const dow = c.getUTCDay()
      if (dpw === 5 && dow >= 1 && dow <= 5) activationDays++
      else if (dpw === 6 && dow >= 1 && dow <= 6) activationDays++
      c.setUTCDate(c.getUTCDate() + 1)
    }
  }

  const includeSF = shadow_fencing !== false
  const includeSD = smart_directional ?? false
  const includeDID = device_id ?? false
  const studies = (rawStudies ?? [])
    .map((s: string) => s.trim().toLowerCase())
    .filter((s: string): s is StudyType => (VALID_STUDIES as readonly string[]).includes(s))

  const marketSizeTierId = await resolveMarketSizeTierId(market)
  const quote = computeQuote({
    truckCount: truck_count, days: activationDays, operatingHours: opHours,
    marketSizeTierId, includeSmartDirectional: includeSD, includeDeviceId: includeDID, studies,
  })

  let mediaTotal = quote.good.baseMedia
  if (includeSF) mediaTotal += quote.better.shadowFencing
  if (includeSD) mediaTotal += quote.better.smartDirectional
  if (includeDID) mediaTotal += quote.better.deviceId
  if (quote.best.reachOk && studies.length > 0) mediaTotal += studies.length * quote.best.studyCost

  const repoTrucks = selectedTrucks.filter(t => t.transport.needed)
  const { leadBusinessDays } = (await selectTrucksForHold({ market, startDate: start_date, endDate: end_date, truckCount: truck_count })).availability.campaignFlags
  const transportAbsorbed = activationDays >= 10 && leadBusinessDays >= 10
  const transportCharge = transportAbsorbed ? 0 : repoTrucks.reduce((sum, t) => sum + t.transport.chargePerTruck, 0)
  const serverTotal = mediaTotal + transportCharge

  let pricingTier = 'Custom'
  if (!includeSF && !includeSD && !includeDID && studies.length === 0) pricingTier = 'Good'
  else if (includeSF && !includeSD && !includeDID && studies.length === 0) pricingTier = 'Better'
  else if (includeSF && studies.length > 0 && quote.best.reachOk) pricingTier = 'Best'

  const featuresJson = JSON.stringify({
    dailyRate: quote.dailyRate, hourSurcharge: quote.hourSurcharge,
    truckDays: quote.input.truckDays, truckCount: truck_count,
    activationDays, calendarDays, daysPerWeek: dpw, operatingHours: opHours,
    baseMedia: quote.good.baseMedia,
    shadowFencing: includeSF ? quote.better.shadowFencing : 0,
    shadowFencingFloored: quote.better.shadowFencingFloored,
    smartDirectionalIncluded: includeSD, smartDirectional: includeSD ? quote.better.smartDirectional : 0,
    deviceIdIncluded: includeDID, deviceId: includeDID ? quote.better.deviceId : 0,
    studies, studyCost: quote.best.studyCost,
    studiesTotal: quote.best.reachOk ? studies.length * quote.best.studyCost : 0,
    transportCharge,
  })

  // Find a ClientUser linked to this SFDC Account if one exists.
  const linkedClient = await prisma.clientUser.findFirst({
    where: { sfdc_account_id: sfdc_account_id },
    select: { id: true },
  })

  // Resolve the service user for Hold.created_by (FK to app_users)
  const serviceUser = await prisma.user.findFirst({
    where: { email: SFDC_SERVICE_USER_EMAIL },
    select: { id: true },
  })
  const createdBy = (token.id as string) || serviceUser?.id || 'system'

  // Create holds directly (unified — no more dual-write to HoldRequest)
  const created: string[] = []
  for (const truck of selectedTrucks) {
    try {
      await prisma.hold.create({
        data: {
          truck_number:      truck.truckNumber,
          client_name:       sfdc_account_name || 'Unknown',
          market,
          state:             resolvedState ?? '',
          start_date:        new Date(start_date),
          end_date:          new Date(end_date),
          status:            'HOLD',
          source:            'INTERNAL',
          origination:       'frontend',
          notes:             `Internal quote for ${sfdc_account_name || 'Unknown'}`,
          created_by:        createdBy,
          client_user_id:    linkedClient?.id ?? null,
          pricing_tier:      pricingTier,
          quoted_total:      serverTotal,
          daily_rate:        quote.dailyRate,
          features:          featuresJson,
          truck_count:       selectedTrucks.length,
          campaign_group_id: campaignGroupId,
          expires_at:        expiresAt,
        },
      })
      created.push(truck.truckNumber)
    } catch (err) {
      console.error('[quote/hold] failed to create hold for truck:', truck.truckNumber, err)
    }
  }

  if (created.length === 0) {
    return NextResponse.json({ error: 'Failed to create holds' }, { status: 500 })
  }

  // Create Salesforce Opportunity
  let sfdcOpportunityId: string | null = null
  if (isSfdcConfigured()) {
    try {
      const parsedFeatures = parseQuoteFeatures(featuresJson)
      const activationNotes = parsedFeatures
        ? buildActivationNotes(parsedFeatures, pricingTier)
        : undefined

      const result = await createOpportunity({
        accountId: sfdc_account_id,
        name: `${sfdc_account_name || 'Client'} - ${market} - ${start_date} to ${end_date}`,
        stageName: 'WARM',
        closeDate: start_date,
        amount: serverTotal,
        market,
        holdStart: start_date,
        holdStop: end_date,
        holdExp: expiresAt.toISOString().split('T')[0],
        truckNumbers: created,
        activationNotes,
      })

      if (result.success && result.id) {
        sfdcOpportunityId = result.id
        await prisma.hold.updateMany({
          where: { campaign_group_id: campaignGroupId },
          data: { sfdc_opportunity_id: result.id },
        })
      } else {
        console.error('[quote/hold] SFDC opportunity creation failed:', result.errors)
      }
    } catch (err) {
      console.error('[quote/hold] SFDC opportunity creation error:', err)
    }
  }

  return NextResponse.json({
    ok: true,
    created: created.length,
    campaignGroupId,
    sfdcOpportunityId,
    message: `Reserved ${created.length} truck${created.length > 1 ? 's' : ''} for ${sfdc_account_name || 'client'}. ${sfdcOpportunityId ? 'Salesforce opportunity created.' : ''}`,
  })
}

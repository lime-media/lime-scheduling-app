import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getClientSession } from '@/lib/clientAuth'
import { createClientHold } from '@/lib/holdRequestService'
import { selectTrucksForHold } from '@/lib/availabilityEngine'
import { createOpportunity, isSfdcConfigured } from '@/lib/salesforceClient'
import { parseQuoteFeatures, buildActivationNotes } from '@/lib/quoteFeatures'
import { computeQuote, VALID_STUDIES, type StudyType } from '@/lib/pricing'
import { resolveMarketSizeTierId, resolveRateOverrides } from '@/lib/pricing/resolvers'

export async function GET(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const holds = await prisma.hold.findMany({
    where:   { client_user_id: session.id },
    orderBy: { created_at: 'desc' },
  })

  return NextResponse.json({
    holdRequests: holds.map((r) => ({
      id:                r.id,
      truck_number:      r.truck_number,
      market:            r.market,
      state:             r.state ?? '',
      start_date:        r.start_date.toISOString().split('T')[0],
      end_date:          r.end_date.toISOString().split('T')[0],
      notes:             r.notes ?? '',
      status:            r.status,
      company_name:      session.companyName,
      pricing_tier:      r.pricing_tier ?? null,
      quoted_total:      r.quoted_total ?? null,
      daily_rate:        r.daily_rate ?? null,
      features:          r.features ?? null,
      truck_count:       r.truck_count ?? null,
      campaign_group_id: r.campaign_group_id ?? null,
      expires_at:        r.expires_at?.toISOString() ?? null,
      extension_until:   r.extension_until?.toISOString().split('T')[0] ?? null,
      extension_reason:  r.extension_reason ?? null,
    })),
  })
}

export async function POST(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()

    // Auto-select trucks when truck_number is not provided.
    if (!body.truck_number && body.market && body.start_date && body.end_date && body.truck_count) {
      return handleAutoSelectHold(req, session, body)
    }

    // Legacy flow: client provides a specific truck_number (drag-on-grid)
    const { truck_number, market, state, start_date, end_date, notes } = body
    if (!truck_number || !start_date || !end_date) {
      return NextResponse.json({ error: 'truck_number, start_date, end_date required' }, { status: 400 })
    }

    const hold = await createClientHold(session, {
      truck_number, market, state, start_date, end_date, notes,
    })

    return NextResponse.json({ ok: true, id: hold.id })
  } catch (e) {
    console.error('[client/hold-requests POST]', e)
    return NextResponse.json({ error: 'Failed to create hold' }, { status: 500 })
  }
}

/**
 * Auto-select trucks and create holds for a campaign.
 *
 * IMPORTANT: All pricing is recomputed server-side from market/dates/truck_count
 * and the client's feature selections. Client-sent quoted_total/daily_rate values
 * are ignored — the trust boundary is the HTTP request, not the UI.
 */
async function handleAutoSelectHold(
  _req: NextRequest,
  session: Awaited<ReturnType<typeof getClientSession>> & {},
  body: {
    market: string
    state?: string
    start_date: string
    end_date: string
    truck_count: number
    notes?: string
    shadow_fencing?: boolean
    smart_directional?: boolean
    device_id?: boolean
    studies?: string[]
    days_per_week?: number
    operating_hours?: number
  },
) {
  const {
    market, state, start_date, end_date, truck_count, notes,
  } = body

  if (truck_count < 1 || truck_count > 20) {
    return NextResponse.json({ error: 'truck_count must be between 1 and 20' }, { status: 400 })
  }

  const { selectedTrucks, availability } = await selectTrucksForHold({
    market,
    startDate: start_date,
    endDate: end_date,
    truckCount: truck_count,
  })

  if (selectedTrucks.length === 0) {
    return NextResponse.json({
      error: 'No trucks available for the requested dates and market.',
    }, { status: 409 })
  }

  // ── Server-side price recomputation ──────────────────────────────────────
  const startDate = new Date(start_date + 'T00:00:00Z')
  const endDate = new Date(end_date + 'T00:00:00Z')
  const calendarDays = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1
  const defaultDaysPerWeek = calendarDays <= 6 ? 7 : 5
  const daysPerWeek = body.days_per_week ?? defaultDaysPerWeek
  const operatingHours = body.operating_hours ?? 8

  let activationDays = calendarDays
  if (daysPerWeek < 7) {
    activationDays = 0
    const c = new Date(start_date + 'T00:00:00Z')
    const e = new Date(end_date + 'T00:00:00Z')
    while (c <= e) {
      const dow = c.getUTCDay()
      if (daysPerWeek === 5 && dow >= 1 && dow <= 5) activationDays++
      else if (daysPerWeek === 6 && dow >= 1 && dow <= 6) activationDays++
      c.setUTCDate(c.getUTCDate() + 1)
    }
  }

  const includeShadowFencing = body.shadow_fencing !== false
  const includeSmartDirectional = body.smart_directional ?? false
  const includeDeviceId = body.device_id ?? false
  const studies = (body.studies ?? [])
    .map(s => s.trim().toLowerCase())
    .filter((s): s is StudyType => (VALID_STUDIES as readonly string[]).includes(s))

  const [marketSizeTierId, rateOverrides] = await Promise.all([
    resolveMarketSizeTierId(market),
    resolveRateOverrides(session),
  ])

  const quote = computeQuote({
    truckCount: truck_count,
    days: activationDays,
    operatingHours,
    marketSizeTierId,
    includeSmartDirectional,
    includeDeviceId,
    studies,
    rateOverrides,
  })

  let mediaTotal = quote.good.baseMedia
  if (includeShadowFencing) mediaTotal += quote.better.shadowFencing
  if (includeSmartDirectional) mediaTotal += quote.better.smartDirectional
  if (includeDeviceId) mediaTotal += quote.better.deviceId
  if (quote.best.reachOk && studies.length > 0) {
    mediaTotal += studies.length * quote.best.studyCost
  }

  const repoTrucks = selectedTrucks.filter(t => t.transport.needed)
  const MIN_DAYS_TO_ABSORB = 10
  const MIN_LEAD_DAYS_TO_ABSORB = 10
  const leadBusinessDays = availability.campaignFlags.leadBusinessDays
  const transportAbsorbed = rateOverrides?.transport_included || (activationDays >= MIN_DAYS_TO_ABSORB && leadBusinessDays >= MIN_LEAD_DAYS_TO_ABSORB)
  const transportCharge = transportAbsorbed
    ? 0
    : repoTrucks.reduce((sum, t) => sum + t.transport.chargePerTruck, 0)

  const serverTotal = mediaTotal + transportCharge

  let pricingTier = 'Custom'
  if (!includeShadowFencing && !includeSmartDirectional && !includeDeviceId && studies.length === 0) pricingTier = 'Good'
  else if (includeShadowFencing && !includeSmartDirectional && !includeDeviceId && studies.length === 0) pricingTier = 'Better'
  else if (includeShadowFencing && studies.length > 0 && quote.best.reachOk) pricingTier = 'Best'

  const featuresJson = JSON.stringify({
    dailyRate: quote.dailyRate,
    hourSurcharge: quote.hourSurcharge,
    truckDays: quote.input.truckDays,
    truckCount: truck_count,
    activationDays,
    calendarDays,
    daysPerWeek,
    operatingHours,
    baseMedia: quote.good.baseMedia,
    shadowFencing: includeShadowFencing ? quote.better.shadowFencing : 0,
    shadowFencingFloored: quote.better.shadowFencingFloored,
    smartDirectionalIncluded: includeSmartDirectional,
    smartDirectional: includeSmartDirectional ? quote.better.smartDirectional : 0,
    deviceIdIncluded: includeDeviceId,
    deviceId: includeDeviceId ? quote.better.deviceId : 0,
    studies,
    studyCost: quote.best.studyCost,
    studiesTotal: quote.best.reachOk ? studies.length * quote.best.studyCost : 0,
    transportCharge,
  })

  // ── Create holds ────────────────────────────────────────────────────────
  const campaignGroupId = `cg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const resolvedState = state || market.split(',')[1]?.trim() || null

  const created: string[] = []
  const failed: string[] = []

  for (const truck of selectedTrucks) {
    try {
      await createClientHold(session, {
        truck_number: truck.truckNumber,
        market,
        state: resolvedState,
        start_date,
        end_date,
        notes: notes ?? null,
        pricing_tier: pricingTier,
        quoted_total: serverTotal,
        daily_rate: quote.dailyRate,
        features: featuresJson,
        truck_count: selectedTrucks.length,
        campaign_group_id: campaignGroupId,
      })
      created.push(truck.truckNumber)
    } catch (err) {
      console.error('[client/hold-requests] failed to create hold for truck:', truck.truckNumber, err)
      failed.push(truck.truckNumber)
    }
  }

  if (created.length === 0) {
    return NextResponse.json({ error: 'Failed to create holds' }, { status: 500 })
  }

  // Create Salesforce Opportunity if the client has an SFDC Account ID
  if (session.sfdcAccountId && isSfdcConfigured() && created.length > 0) {
    try {
      const oppName = `${session.companyName} - ${market} - ${start_date} to ${end_date}`
      const firstHold = await prisma.hold.findFirst({
        where: { campaign_group_id: campaignGroupId },
        select: { expires_at: true },
      })

      const parsedFeatures = parseQuoteFeatures(featuresJson)
      const activationNotes = parsedFeatures
        ? buildActivationNotes(parsedFeatures, pricingTier)
        : undefined

      const result = await createOpportunity({
        accountId: session.sfdcAccountId,
        name: oppName,
        stageName: 'WARM',
        closeDate: start_date,
        amount: serverTotal,
        market,
        holdStart: start_date,
        holdStop: end_date,
        holdExp: firstHold?.expires_at?.toISOString().split('T')[0],
        truckNumbers: created,
        activationNotes,
      })

      if (result.success && result.id) {
        await prisma.hold.updateMany({
          where: { campaign_group_id: campaignGroupId },
          data: { sfdc_opportunity_id: result.id },
        })
      } else {
        console.error('[client/hold-requests] SFDC opportunity creation failed:', result.errors)
      }
    } catch (err) {
      console.error('[client/hold-requests] SFDC opportunity creation error:', err)
    }
  }

  return NextResponse.json({
    ok: true,
    created: created.length,
    failed: failed.length,
    campaignGroupId,
    trucksRequested: truck_count,
    trucksAvailable: availability.counts.total,
    message: `Reserved ${created.length} truck${created.length > 1 ? 's' : ''}. Holds expire in 72 hours.`,
  })
}

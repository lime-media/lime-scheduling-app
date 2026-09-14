import { NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { prisma } from '@/lib/prisma'
import {
  computeQuote,
  priceTransport,
  estimatedLegs,
  marginCheck,
  countActivationDays,
  countCalendarDays,
  defaultDaysPerWeek,
  resolveNearestAcceptedMarket,
  type QuoteInput,
  type RateOverrides,
  type StudyType,
} from '@/lib/pricing'

/**
 * Canonical quote endpoint for the MCP server.
 *
 * Pricing rules live entirely in lib/pricing — this route does no pricing math
 * of its own. It differs from the client quote routes in ONE respect: it has no
 * truck selection, so it cannot know where individual trucks are. It therefore
 * estimates every truck as sitting at the nearest accepted market and hands
 * those legs to the same transport engine the client routes use.
 *
 * That estimate is conservative. Once real trucks are selected, the client
 * routes price the same campaign from live GPS and may come in lower.
 */

type QuoteRequestBody = {
  start_date: string
  end_date: string
  truck_count: number
  operating_hours?: number
  days_per_week?: 5 | 6 | 7
  market_size_tier?: number
  include_smart_directional?: boolean
  include_device_id?: boolean
  studies?: string[]
  // Transport inputs (from MCP geocoding)
  lead_business_days?: number
  campaign_lat?: number
  campaign_lng?: number
  // Partner context (for rate agreement lookup)
  partner_id?: string
}

export async function POST(request: Request) {
  const authError = validateInternalApiKey(request)
  if (authError) return authError

  let body: QuoteRequestBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const {
    truck_count,
    start_date,
    end_date,
    operating_hours = 8,
    market_size_tier = 3,
    include_smart_directional = false,
    include_device_id = false,
    studies = [],
    lead_business_days,
    campaign_lat,
    campaign_lng,
    partner_id,
  } = body

  if (!truck_count || truck_count < 1) {
    return NextResponse.json({ error: 'truck_count must be at least 1' }, { status: 400 })
  }
  if (!start_date || !end_date) {
    return NextResponse.json({ error: 'start_date and end_date are required' }, { status: 400 })
  }

  const calendarDays = countCalendarDays(start_date, end_date)
  if (!Number.isFinite(calendarDays) || calendarDays < 1) {
    return NextResponse.json({ error: 'end_date must be on or after start_date' }, { status: 400 })
  }

  // Bill activation days, not the calendar span — same rule as every other
  // quoting surface. A two-week Mon-Fri campaign is 10 days, not 14.
  const daysPerWeek = body.days_per_week ?? defaultDaysPerWeek(calendarDays)
  const days = countActivationDays(start_date, end_date, daysPerWeek)

  try {
    // Rate Agreement lookup
    let rateOverrides: RateOverrides | null = null
    let agreementName: string | null = null

    if (partner_id) {
      const now = new Date()
      const agreement = await prisma.rateAgreement.findFirst({
        where: {
          partner_id,
          effective_date: { lte: now },
          expiration_date: { gte: now },
        },
        orderBy: { created_at: 'desc' },
      })

      if (agreement) {
        try {
          rateOverrides = JSON.parse(agreement.rate_overrides) as RateOverrides
          agreementName = agreement.name
        } catch {
          // Invalid JSON in overrides — fall through to standard pricing
        }
      }
    }

    const quoteInput: QuoteInput = {
      truckCount: truck_count,
      days,
      operatingHours: operating_hours,
      marketSizeTierId: market_size_tier,
      includeSmartDirectional: include_smart_directional,
      includeDeviceId: include_device_id,
      studies: studies as StudyType[],
      rateOverrides,
    }

    const quote = computeQuote(quoteInput)

    if (agreementName) {
      quote.pricingBasis = `agreement: ${agreementName}`
    }

    // Transport — same engine as the client routes, fed estimated legs.
    let transport = null
    let margin = null
    let nearestDistance: number | null = null

    if (campaign_lat !== undefined && campaign_lng !== undefined && lead_business_days !== undefined) {
      const nearestMarket = await resolveNearestAcceptedMarket(campaign_lat, campaign_lng)

      if (nearestMarket) {
        nearestDistance = nearestMarket.distanceMiles

        transport = priceTransport({
          activationDays: days,
          leadBusinessDays: lead_business_days,
          legs: estimatedLegs(
            truck_count,
            nearestDistance,
            rateOverrides?.service_area_miles,
          ),
          transportIncluded: rateOverrides?.transport_included,
          overrides: {
            dayRate: rateOverrides?.transport_day_rate,
            airfare: rateOverrides?.transport_airfare,
            hotelPerNight: rateOverrides?.transport_hotel_per_night,
          },
        })

        // Internal margin check — NEVER returned to buyer-facing surfaces
        margin = marginCheck(
          days,
          quote.effectiveDailyRate,
          transport.outcome === 'BILLED',
          nearestDistance,
        )
      }
    }

    const response: Record<string, unknown> = {
      quote,
      campaign: {
        start_date,
        end_date,
        days,
        calendar_days: calendarDays,
        activation_days: days,
        days_per_week: daysPerWeek,
        truck_count,
      },
    }

    // Presentation: absorbed transport emits no line at all (spec §7)
    if (transport) {
      if (transport.outcome === 'BILLED') {
        response.transport = {
          outcome: 'BILLED',
          estimated: true,
          estimatedFromMiles: nearestDistance,
          transportDays: transport.legs[0]?.transportDays ?? 0,
          truckCount: transport.repositioningTruckCount,
          chargePerTruck: transport.legs[0]?.charge ?? 0,
          transportCharge: transport.charge,
          depositRequired: transport.depositRequired,
          depositPerTruck: transport.depositRequired ? transport.depositPerTruck : undefined,
          depositAmount: transport.depositRequired ? transport.depositAmount : undefined,
          grandTotalWithTransport: quote.best.total + transport.charge,
        }
      }
    }

    if (margin) {
      response._internal = {
        margin,
        _warning: 'INTERNAL ONLY — never expose to buyers',
      }
    }

    return NextResponse.json(response)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[v1/internal/quote] Error:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

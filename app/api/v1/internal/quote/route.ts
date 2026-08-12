import { NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { prisma } from '@/lib/prisma'
import {
  computeQuote,
  priceTransport,
  marginCheck,
  type QuoteInput,
  type TransportOrder,
  type RateOverrides,
  type StudyType,
  type TransportResult,
} from '@/lib/pricing'

type QuoteRequestBody = {
  start_date: string
  end_date: string
  truck_count: number
  operating_hours?: number
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

/**
 * Haversine distance in miles between two lat/lng points.
 */
function haversineDistanceMiles(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 3958.8 // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
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

  // Validate required fields
  if (!truck_count || truck_count < 1) {
    return NextResponse.json({ error: 'truck_count must be at least 1' }, { status: 400 })
  }
  if (!start_date || !end_date) {
    return NextResponse.json({ error: 'start_date and end_date are required' }, { status: 400 })
  }

  const start = new Date(start_date + 'T00:00:00Z')
  const end = new Date(end_date + 'T00:00:00Z')
  const days = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1
  if (days < 1) {
    return NextResponse.json({ error: 'end_date must be on or after start_date' }, { status: 400 })
  }

  try {
    // Look up Rate Agreement if partner_id provided
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

    // Compute the tiered quote
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

    // Evaluate transport if we have location + lead time
    let transport: TransportResult | null = null
    let margin = null

    if (campaign_lat !== undefined && campaign_lng !== undefined && lead_business_days !== undefined) {
      // Find the nearest accepted market
      const acceptedMarkets = await prisma.acceptedMarket.findMany({
        where: { is_active: true },
      })

      if (acceptedMarkets.length === 0) {
        // No accepted markets configured — skip transport evaluation
      } else {
        let nearestMarket = acceptedMarkets[0]
        let nearestDistance = Infinity

        for (const market of acceptedMarkets) {
          const dist = haversineDistanceMiles(campaign_lat, campaign_lng, market.lat, market.lng)
          if (dist < nearestDistance) {
            nearestDistance = dist
            nearestMarket = market
          }
        }

        nearestDistance = Math.round(nearestDistance * 10) / 10

        const transportOrder: TransportOrder = {
          flightDays: days,
          leadBusinessDays: lead_business_days,
          simultaneousUnits: truck_count,
          distanceToNearestMarketMiles: nearestDistance,
          nearestMarketDma: nearestMarket.dma_name,
          nearestMarketBaseConcurrency: nearestMarket.base_concurrency,
        }

        transport = priceTransport(transportOrder)

        // Internal margin check — NEVER returned to buyer-facing surfaces
        if (transport.outcome !== 'MANUAL_QUOTE') {
          margin = marginCheck(
            days,
            quote.effectiveDailyRate,
            transport.outcome === 'BILLED',
            nearestDistance,
          )
        }
      }
    }

    // Build response
    const response: Record<string, unknown> = {
      quote,
      campaign: { start_date, end_date, days, truck_count },
    }

    // Transport: follow spec §7 presentation rules
    if (transport) {
      if (transport.outcome === 'MANUAL_QUOTE') {
        response.transport = {
          outcome: 'MANUAL_QUOTE',
          reason: transport.reason,
          message: 'This configuration requires a custom quote. A rep will follow up.',
        }
      } else if (transport.outcome === 'BILLED') {
        response.transport = {
          outcome: 'BILLED',
          triggers: transport.triggers,
          transportDays: transport.transportDays,
          truckCount: transport.truckCount,
          chargePerTruck: transport.chargePerTruck,
          transportCharge: transport.transportCharge,
          depositRequired: transport.depositRequired,
          depositPerTruck: transport.depositRequired ? transport.depositPerTruck : undefined,
          depositAmount: transport.depositRequired ? transport.depositAmount : undefined,
          grandTotalWithTransport: quote.best.total + transport.transportCharge,
        }
      }
      // INCLUDED → no transport key at all (spec §7: not a $0 line)
    }

    // Internal margin — include but mark clearly
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

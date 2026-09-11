/**
 * Internal quote API — same pricing logic as the client-facing
 * POST /api/client/quote, but authenticated via NextAuth (internal staff)
 * and accepts a sfdc_account_id for Salesforce opportunity creation.
 *
 * This endpoint is used by the internal /quote page.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { checkAvailability, legsFromTrucks } from '@/lib/availabilityEngine'
import {
  computeQuote,
  priceTransport,
  countActivationDays,
  defaultDaysPerWeek,
  VALID_STUDIES,
  type StudyType,
} from '@/lib/pricing'
import {
  resolveMarketSizeTierId,
  resolveRateOverridesBySfdcAccount,
  resolveDefaultRateOverrides,
} from '@/lib/pricing/resolvers'
import { resolveMarketInput } from '@/lib/marketCoordinates'
import type { RateOverrides } from '@/lib/pricing/config'

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: {
    market: string
    start_date: string
    end_date: string
    truck_count: number
    shadow_fencing?: boolean
    smart_directional?: boolean
    device_id?: boolean
    studies?: string[]
    days_per_week?: 5 | 6 | 7
    operating_hours?: number
    sfdc_account_id?: string
    sfdc_account_name?: string
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { market, start_date, end_date, truck_count } = body
  if (!market || !start_date || !end_date || !truck_count || truck_count < 1) {
    return NextResponse.json({ error: 'market, start_date, end_date, and truck_count (>= 1) are required' }, { status: 400 })
  }

  // Market resolution
  const marketMatches = resolveMarketInput(market)
  if (marketMatches.length === 0) {
    return NextResponse.json({
      error: `We couldn't find "${market}" in our market database. Please include the state abbreviation (e.g. "Portland, OR").`,
    }, { status: 400 })
  }
  if (marketMatches.length > 1) {
    return NextResponse.json({
      error: 'DISAMBIGUATION_REQUIRED',
      message: `Multiple markets match "${market}". Please select one:`,
      candidates: marketMatches.map(m => m.formal),
    }, { status: 400 })
  }

  const formalMarket = marketMatches[0].formal

  // Contiguous 48 states
  const EXCLUDED_STATES = new Set(['AK', 'HI'])
  const stateAbbr = formalMarket.split(',').pop()?.trim().toUpperCase()
  if (stateAbbr && EXCLUDED_STATES.has(stateAbbr)) {
    return NextResponse.json({
      error: `We currently only serve markets within the contiguous 48 states. ${formalMarket} is outside our service area.`,
    }, { status: 400 })
  }

  const startDate = new Date(start_date + 'T00:00:00Z')
  const endDate = new Date(end_date + 'T00:00:00Z')
  const calendarDays = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1
  if (!Number.isFinite(calendarDays) || calendarDays < 1) {
    return NextResponse.json({ error: 'Invalid date range' }, { status: 400 })
  }

  const daysPerWeek = body.days_per_week ?? defaultDaysPerWeek(calendarDays)
  const operatingHours = body.operating_hours ?? 8

  const days = countActivationDays(start_date, end_date, daysPerWeek)

  const studies = (body.studies ?? [])
    .map(s => s.trim().toLowerCase())
    .filter((s): s is StudyType => (VALID_STUDIES as readonly string[]).includes(s))

  const includeShadowFencing = body.shadow_fencing !== false
  const includeSmartDirectional = body.smart_directional ?? false
  const includeDeviceId = body.device_id ?? false

  // Resolve rate overrides first — service_area_miles affects availability classification
  const defaultOverrides = await resolveDefaultRateOverrides()
  let rateOverrides: RateOverrides | undefined = defaultOverrides ?? undefined
  let agreementName: string | undefined
  if (body.sfdc_account_id) {
    const result = await resolveRateOverridesBySfdcAccount(body.sfdc_account_id)
    if (result.overrides) {
      rateOverrides = { ...rateOverrides, ...result.overrides }
      if (result.overrides.daily_rates) {
        rateOverrides.daily_rates = { ...rateOverrides?.daily_rates, ...result.overrides.daily_rates }
      }
      agreementName = result.agreementName
    }
  }

  const [availability, marketSizeTierId] = await Promise.all([
    checkAvailability({
      market: formalMarket,
      startDate: start_date,
      endDate: end_date,
      truckCount: truck_count,
      serviceAreaMiles: rateOverrides?.service_area_miles,
    }),
    resolveMarketSizeTierId(formalMarket),
  ])

  if (!availability.sufficient) {
    return NextResponse.json({
      availability: {
        requested: truck_count,
        available: availability.counts.total,
        local: availability.counts.local,
        nearby: availability.counts.nearby,
        repositioning: availability.counts.repositioning,
        sufficient: false,
      },
      insufficient: true,
      message: `${availability.counts.total} trucks available, but ${truck_count} requested.`,
    })
  }

  const selectedTrucks = availability.trucks.slice(0, truck_count)

  const quote = computeQuote({
    truckCount: truck_count,
    days,
    operatingHours,
    marketSizeTierId,
    includeSmartDirectional,
    includeDeviceId,
    studies,
    rateOverrides,
  })

  const transport = priceTransport({
    activationDays: days,
    leadBusinessDays: availability.campaignFlags.leadBusinessDays,
    legs: legsFromTrucks(selectedTrucks),
    baseConcurrency: availability.nearestAcceptedMarket?.baseConcurrency ?? null,
    transportIncluded: rateOverrides?.transport_included,
    overrides: {
      dayRate: rateOverrides?.transport_day_rate,
      airfare: rateOverrides?.transport_airfare,
      hotelPerNight: rateOverrides?.transport_hotel_per_night,
    },
  })

  // Swarm: surfaced through the same channel the pages already use for
  // "can't quote this" so the UI shows a message instead of a partial result.
  if (transport.outcome === 'MANUAL_QUOTE') {
    return NextResponse.json({
      insufficient: true,
      message: 'This campaign needs more trucks than the market can field concurrently. It requires a custom quote — a rep will follow up.',
      transport: { outcome: 'MANUAL_QUOTE', reason: transport.reason },
    })
  }

  const totalTransportCharge = transport.charge

  let mediaTotal = quote.good.baseMedia
  if (includeShadowFencing) mediaTotal += quote.better.shadowFencing
  if (includeSmartDirectional) mediaTotal += quote.better.smartDirectional
  if (includeDeviceId) mediaTotal += quote.better.deviceId
  if (quote.best.reachOk && studies.length > 0) {
    mediaTotal += studies.length * quote.best.studyCost
  }

  const grandTotal = mediaTotal + totalTransportCharge

  let activeTier: string = 'Custom'
  if (!includeShadowFencing && !includeSmartDirectional && !includeDeviceId && studies.length === 0) activeTier = 'Good'
  else if (includeShadowFencing && !includeSmartDirectional && !includeDeviceId && studies.length === 0) activeTier = 'Better'
  else if (includeShadowFencing && studies.length > 0 && quote.best.reachOk) activeTier = 'Best'

  return NextResponse.json({
    availability: {
      requested: truck_count,
      available: availability.counts.total,
      local: availability.counts.local,
      nearby: availability.counts.nearby,
      repositioning: availability.counts.repositioning,
      sufficient: true,
      cannotArrive: availability.counts.cannotArrive,
      wouldStrandSuccessor: availability.counts.wouldStrandSuccessor,
      originFellBackToGps: availability.counts.originFellBackToGps,
      gpsFallbackMarkets: [...new Set(
        availability.trucks
          .map(t => t.chain.inbound.originFellBackToGps)
          .filter((m): m is string => Boolean(m)),
      )],
      excluded: availability.infeasible.map(t => ({
        truckNumber: t.truckNumber,
        from: t.currentMarket || 'Unknown',
        reason: t.reason,
        detail: t.detail,
      })),
      requiresOverride: availability.trucks
        .filter(t => t.requiresOverride)
        .map(t => ({
          truckNumber: t.truckNumber,
          from: t.currentMarket || 'Unknown',
          detail: t.chain.detail ?? '',
        })),
    },
    pricing: {
      dailyRate: quote.dailyRate,
      effectiveDailyRate: quote.effectiveDailyRate,
      hourSurcharge: quote.hourSurcharge,
      truckDays: quote.input.truckDays,
      days,
      calendarDays,
      truckCount: truck_count,
      baseMedia: quote.good.baseMedia,
      pricingBasis: agreementName ? `agreement: ${agreementName}` : 'standard',
      marketSizeTier: quote.input.marketSizeTier,
      schedule: { daysPerWeek, operatingHours, activationDays: days },
    },
    features: {
      shadowFencing: { included: includeShadowFencing, cost: quote.better.shadowFencing, floored: quote.better.shadowFencingFloored, digitalImpressions: quote.better.digitalImpressions },
      smartDirectional: { included: includeSmartDirectional, cost: includeSmartDirectional ? quote.better.smartDirectional : quote.input.truckDays * (rateOverrides?.smart_directional_daily ?? 250) },
      deviceId: { included: includeDeviceId, cost: includeDeviceId ? quote.better.deviceId : (rateOverrides?.device_id_flat ?? 2500) },
      studies: { available: quote.best.reachOk, selected: studies, costPerStudy: quote.best.studyCost, estimatedImpressions: quote.best.estimatedImpressions, reachMinimum: 1_200_000 },
    },
    transport: {
      outcome: transport.outcome,
      charge: transport.charge,
      absorbed: transport.absorbed,
      absorbedReason: transport.absorbedReason,
      repositioning: {
        truckCount: transport.repositioningTruckCount,
        charge: transport.charge,
        trucks: transport.legs.map(l => ({
          distanceMiles: l.distanceMiles,
          transportDays: l.transportDays,
          charge: l.charge,
          from: l.fromMarket ?? 'Unknown',
        })),
      },
      localCount: transport.localTruckCount,
      depositRequired: transport.depositRequired,
      depositAmount: transport.depositAmount,
    },
    _internal: {
      // Deadhead this booking adds to each truck's next job. Flagged, not billed:
      // the successor's transport was quoted when it was booked and is not re-rated.
      chainFlags: selectedTrucks
        .filter(t => t.chain.successor && !t.chain.successor.unresolvedMarket
          && (t.chain.successor.deltaTransportDays !== 0 || t.chain.successor.deltaCost !== 0))
        .map(t => ({
          truckNumber: t.truckNumber,
          successorMarket: t.chain.successor!.market,
          successorStart: t.chain.successor!.startsOn,
          deltaTransportDays: t.chain.successor!.deltaTransportDays,
          deltaCost: Math.round(t.chain.successor!.deltaCost),
        })),
      _warning: 'INTERNAL ONLY — never expose to buyers',
    },
    market: formalMarket,
    activeTier,
    mediaTotal,
    transportCharge: totalTransportCharge,
    grandTotal,
    presets: {
      good: { total: quote.good.total, description: 'Base media only' },
      better: { total: quote.better.total, description: 'Base media + shadow fencing' },
      best: { total: quote.best.total, description: 'Full measurement suite', available: quote.best.reachOk,
        reason: !quote.best.reachOk ? `Projected reach (${Math.round(quote.best.estimatedImpressions).toLocaleString('en-US')} impressions) is below the 1,200,000 minimum for lift studies.` : undefined },
    },
    // Pass through for hold placement
    selectedTrucks: selectedTrucks.map(t => t.truckNumber),
  })
}

/**
 * Direct quote API for the client portal.
 *
 * Computes availability (with per-truck transport and travel day blocking),
 * media pricing, and returns per-feature costs for client-side recalculation.
 *
 * Transport model:
 *   - Per-truck: trucks >250mi from the campaign market incur repositioning charges
 *   - Campaign-level: short flight (<3 days) and rush (<10 biz day lead) add surcharges
 *   - Swarm: >3 trucks triggers manual quote
 *   - Travel days are blocked on each truck's schedule
 */

import { NextRequest, NextResponse } from 'next/server'
import { getClientSession } from '@/lib/clientAuth'
import { checkAvailability, recomputeTransportCharge } from '@/lib/availabilityEngine'
import { resolveMarketInput } from '@/lib/marketCoordinates'
import {
  computeQuote,
  VALID_STUDIES,
  TRANSPORT_CONFIG,
  type StudyType,
} from '@/lib/pricing'
import {
  resolveMarketSizeTierId,
  resolveRateOverrides,
  resolveDefaultRateOverrides,
} from '@/lib/pricing/resolvers'

/**
 * Count activation days within a date range based on a weekly schedule.
 * - 7 days/week: every calendar day
 * - 6 days/week: Mon-Sat (skip Sunday)
 * - 5 days/week: Mon-Fri (skip Saturday and Sunday)
 */
function countActivationDays(startStr: string, endStr: string, daysPerWeek: number): number {
  if (daysPerWeek === 7) {
    const start = new Date(startStr + 'T00:00:00Z')
    const end = new Date(endStr + 'T00:00:00Z')
    return Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1
  }

  let count = 0
  const current = new Date(startStr + 'T00:00:00Z')
  const end = new Date(endStr + 'T00:00:00Z')

  while (current <= end) {
    const dow = current.getUTCDay() // 0=Sun, 6=Sat
    if (daysPerWeek === 5) {
      // Mon-Fri
      if (dow >= 1 && dow <= 5) count++
    } else {
      // 6 days: Mon-Sat
      if (dow >= 1 && dow <= 6) count++
    }
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return count
}

export async function POST(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: {
    market: string
    start_date: string
    end_date: string
    truck_count: number
    shadow_fencing?: boolean
    smart_directional?: boolean
    device_id?: boolean
    studies?: string[]
    // Schedule configuration
    days_per_week?: 5 | 6 | 7     // default: 5 for campaigns >6 days, 7 for <=6
    operating_hours?: number       // default: 8 (standard), up to 12
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

  // Resolve the market input — handles disambiguation and formalization
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

  // Single match — use the formalized name going forward
  const resolvedMarket = marketMatches[0]
  const formalMarket = resolvedMarket.formal

  // Only serve the contiguous 48 states
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

  // Schedule configuration:
  // - Campaigns 6 days or less: every day (default days_per_week=7)
  // - Campaigns 7+ days: Mon-Fri schedule (default days_per_week=5)
  // - Client can opt into 6 or 7 day weeks for longer campaigns
  const defaultDaysPerWeek = calendarDays <= 6 ? 7 : 5
  const daysPerWeek = body.days_per_week ?? defaultDaysPerWeek
  const operatingHours = body.operating_hours ?? 8

  // Count actual activation days based on the schedule pattern
  const activationDays = countActivationDays(start_date, end_date, daysPerWeek)
  const days = activationDays

  const studies = (body.studies ?? [])
    .map(s => s.trim().toLowerCase())
    .filter((s): s is StudyType => (VALID_STUDIES as readonly string[]).includes(s))

  const includeShadowFencing = body.shadow_fencing !== false
  const includeSmartDirectional = body.smart_directional ?? false
  const includeDeviceId = body.device_id ?? false

  // Resolve rate overrides first — service_area_miles affects availability classification
  const [clientOverrides, defaultOverrides, marketSizeTierId] = await Promise.all([
    resolveRateOverrides(session),
    resolveDefaultRateOverrides(),
    resolveMarketSizeTierId(formalMarket),
  ])

  const rateOverrides = clientOverrides
    ? { ...defaultOverrides, ...clientOverrides, daily_rates: { ...defaultOverrides?.daily_rates, ...clientOverrides.daily_rates } }
    : defaultOverrides

  const availability = await checkAvailability({
    market: formalMarket,
    startDate: start_date,
    endDate: end_date,
    truckCount: truck_count,
    serviceAreaMiles: rateOverrides?.service_area_miles,
  })

  // Not enough trucks to fill the request — don't offer a price, direct them
  // to submit a request for the team to handle manually.
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
      message: `We have ${availability.counts.total} truck${availability.counts.total !== 1 ? 's' : ''} available for your requested dates, but you need ${truck_count}. Submit a request and the Lime Media team will work on a solution.`,
    })
  }

  // Select the best trucks (closest first, up to requested count)
  const selectedTrucks = availability.trucks.slice(0, truck_count)

  // Compute media pricing
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

  // Per-truck transport: trucks beyond 250mi incur repositioning charges.
  // ABSORBED when BOTH conditions are met:
  //   - Campaign is 10+ activation days
  //   - 10+ business days lead time
  // Otherwise, repositioning is billed to the client.
  const repoTrucks = selectedTrucks.filter(t => t.transport.needed)
  const localTrucks = selectedTrucks.filter(t => !t.transport.needed)

  const MIN_DAYS_TO_ABSORB = 10
  const MIN_LEAD_DAYS_TO_ABSORB = 10
  const leadBusinessDays = availability.campaignFlags.leadBusinessDays
  const transportAbsorbed = rateOverrides?.transport_included || (days >= MIN_DAYS_TO_ABSORB && leadBusinessDays >= MIN_LEAD_DAYS_TO_ABSORB)
  const hasTransportOverrides = rateOverrides?.transport_day_rate != null || rateOverrides?.transport_airfare != null || rateOverrides?.transport_hotel_per_night != null
  const transportOverrides = { dayRate: rateOverrides?.transport_day_rate, airfare: rateOverrides?.transport_airfare, hotelPerNight: rateOverrides?.transport_hotel_per_night }
  const totalTransportCharge = transportAbsorbed
    ? 0
    : repoTrucks.reduce((sum, t) => sum + (hasTransportOverrides ? recomputeTransportCharge(t, transportOverrides) : t.transport.chargePerTruck), 0)

  // Feature costs
  const featureCosts = buildFeaturesResponse(quote, includeShadowFencing, includeSmartDirectional, includeDeviceId, studies, rateOverrides)

  // Compute media total based on selected features
  let mediaTotal = quote.good.baseMedia
  if (includeShadowFencing) mediaTotal += featureCosts.shadowFencing.cost
  if (includeSmartDirectional) mediaTotal += featureCosts.smartDirectional.cost
  if (includeDeviceId) mediaTotal += featureCosts.deviceId.cost
  if (quote.best.reachOk && studies.length > 0) {
    mediaTotal += studies.length * featureCosts.studies.costPerStudy
  }

  const grandTotal = mediaTotal + totalTransportCharge

  // Determine tier preset
  let activeTier: 'Good' | 'Better' | 'Best' | 'Custom' = 'Custom'
  if (!includeShadowFencing && !includeSmartDirectional && !includeDeviceId && studies.length === 0) {
    activeTier = 'Good'
  } else if (includeShadowFencing && !includeSmartDirectional && !includeDeviceId && studies.length === 0) {
    activeTier = 'Better'
  } else if (includeShadowFencing && studies.length > 0 && quote.best.reachOk) {
    activeTier = 'Best'
  }

  return NextResponse.json({
    availability: buildAvailabilityResponse(availability),
    pricing: buildPricingResponse(quote, days, truck_count, calendarDays, daysPerWeek, operatingHours),
    features: featureCosts,
    transport: {
      outcome: repoTrucks.length === 0
        ? 'INCLUDED' as const
        : transportAbsorbed
          ? 'ABSORBED' as const
          : 'BILLED' as const,
      charge: totalTransportCharge,
      absorbed: transportAbsorbed,
      absorbedReason: transportAbsorbed && repoTrucks.length > 0
        ? `Transport included for campaigns of ${MIN_DAYS_TO_ABSORB}+ days with ${MIN_LEAD_DAYS_TO_ABSORB}+ business days notice.`
        : undefined,
      repositioning: {
        truckCount: repoTrucks.length,
        charge: totalTransportCharge,
        trucks: repoTrucks.map(t => ({
          distanceMiles: t.distanceMiles,
          transportDays: t.transport.transportDays,
          charge: transportAbsorbed ? 0 : t.transport.chargePerTruck,
          from: t.currentMarket || 'Unknown',
        })),
      },
      localCount: localTrucks.length,
      depositRequired: !transportAbsorbed && repoTrucks.length > 0,
      depositAmount: !transportAbsorbed && repoTrucks.length > 0
        ? repoTrucks.length * TRANSPORT_CONFIG.depositTransportDays * TRANSPORT_CONFIG.exceptionTransportDayRate
        : 0,
    },
    market: formalMarket,
    activeTier,
    mediaTotal,
    transportCharge: totalTransportCharge,
    grandTotal,
    presets: buildPresetsResponse(quote),
  })
}

// ---------------------------------------------------------------------------
// Response builders (keep the route handler readable)
// ---------------------------------------------------------------------------

function buildAvailabilityResponse(a: Awaited<ReturnType<typeof checkAvailability>>) {
  return {
    requested: a.trucks.length >= 0 ? a.counts.total : 0, // will be overridden below
    available: a.counts.total,
    local: a.counts.local,
    nearby: a.counts.nearby,
    repositioning: a.counts.repositioning,
    sufficient: a.sufficient,
  }
}

function buildPricingResponse(
  quote: ReturnType<typeof computeQuote>,
  days: number,
  truckCount: number,
  calendarDays: number,
  daysPerWeek: number,
  operatingHours: number,
) {
  return {
    dailyRate: quote.dailyRate,
    effectiveDailyRate: quote.effectiveDailyRate,
    hourSurcharge: quote.hourSurcharge,
    truckDays: quote.input.truckDays,
    days,
    calendarDays,
    truckCount,
    baseMedia: quote.good.baseMedia,
    pricingBasis: quote.pricingBasis,
    marketSizeTier: quote.input.marketSizeTier,
    schedule: {
      daysPerWeek,
      operatingHours,
      activationDays: days,
    },
  }
}

function buildFeaturesResponse(
  quote: ReturnType<typeof computeQuote>,
  includeShadowFencing: boolean,
  includeSmartDirectional: boolean,
  includeDeviceId: boolean,
  studies: StudyType[],
  rateOverrides: Awaited<ReturnType<typeof resolveRateOverrides>>,
) {
  return {
    shadowFencing: {
      included: includeShadowFencing,
      cost: quote.better.shadowFencing,
      floored: quote.better.shadowFencingFloored,
      digitalImpressions: quote.better.digitalImpressions,
    },
    smartDirectional: {
      included: includeSmartDirectional,
      cost: quote.better.smartDirectionalIncluded
        ? quote.better.smartDirectional
        : quote.input.truckDays * (rateOverrides?.smart_directional_daily ?? 250),
    },
    deviceId: {
      included: includeDeviceId,
      cost: quote.better.deviceIdIncluded
        ? quote.better.deviceId
        : (rateOverrides?.device_id_flat ?? 2500),
    },
    studies: {
      available: quote.best.reachOk,
      selected: studies,
      costPerStudy: quote.best.studyCost,
      estimatedImpressions: quote.best.estimatedImpressions,
      reachMinimum: 1_200_000,
    },
  }
}

function buildPresetsResponse(quote: ReturnType<typeof computeQuote>) {
  return {
    good: { total: quote.good.total, description: 'Base media only' },
    better: { total: quote.better.total, description: 'Base media + shadow fencing' },
    best: {
      total: quote.best.total,
      description: 'Full measurement suite',
      available: quote.best.reachOk,
      reason: !quote.best.reachOk
        ? `Projected reach (${Math.round(quote.best.estimatedImpressions).toLocaleString('en-US')} impressions) is below the 1,200,000 minimum for lift studies.`
        : undefined,
    },
  }
}

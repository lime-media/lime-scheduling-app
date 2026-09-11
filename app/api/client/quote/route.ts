/**
 * Direct quote API for the client portal.
 *
 * Computes availability (with per-truck transport and travel day blocking),
 * media pricing, and returns per-feature costs for client-side recalculation.
 *
 * Transport is priced by the single engine in lib/pricing/transport.ts — this
 * route measures nothing and decides nothing about transport on its own.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getClientSession } from '@/lib/clientAuth'
import { checkAvailability, legsFromTrucks } from '@/lib/availabilityEngine'
import { resolveMarketInput } from '@/lib/marketCoordinates'
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
  resolveRateOverrides,
  resolveDefaultRateOverrides,
} from '@/lib/pricing/resolvers'


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
  const daysPerWeek = body.days_per_week ?? defaultDaysPerWeek(calendarDays)
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

  // There are exactly two reasons to refuse a quote: the market is outside the
  // service area, or no reachable truck exists. Truck COUNT is never one of
  // them — extra trucks come from further away and the distance is billed.
  if (!availability.marketResolved) {
    return NextResponse.json({
      availability: {
        requested: truck_count, available: 0, local: 0, nearby: 0,
        repositioning: 0, sufficient: false,
      },
      insufficient: true,
      outOfServiceArea: true,
      message: `We could not locate "${formalMarket}". Lime Media serves the contiguous 48 states — check the spelling, or submit a request and the team will follow up.`,
    })
  }

  // Not enough reachable trucks to fill the request — every truck that could
  // physically make these dates is already committed.
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
      message: `We have ${availability.counts.total} truck${availability.counts.total !== 1 ? 's' : ''} that can reach your market for these dates, but you need ${truck_count}. Submit a request and the Lime Media team will work on a solution.`,
    })
  }

  // Select the best trucks (cheapest chain first, up to requested count).
  // Override-only trucks are excluded here for the same reason they are
  // excluded from `sufficient` — displacing a soft hold is a rep's decision.
  const selectedTrucks = availability.trucks
    .filter(t => !t.requiresOverride)
    .slice(0, truck_count)

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

  // Transport — priced by the single engine in lib/pricing/transport.ts
  const transport = priceTransport({
    activationDays: days,
    leadBusinessDays: availability.campaignFlags.leadBusinessDays,
    legs: legsFromTrucks(selectedTrucks),
    transportIncluded: rateOverrides?.transport_included,
    overrides: {
      dayRate: rateOverrides?.transport_day_rate,
      airfare: rateOverrides?.transport_airfare,
      hotelPerNight: rateOverrides?.transport_hotel_per_night,
    },
  })

  const totalTransportCharge = transport.charge

  // Internal signal, server-side only — see buildChainFlags().
  const chainFlags = buildChainFlags(selectedTrucks)
  if (chainFlags.length > 0) {
    console.info('[client/quote] downstream deadhead (not billed):', JSON.stringify(chainFlags))
  }

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
    market: formalMarket,
    activeTier,
    mediaTotal,
    transportCharge: totalTransportCharge,
    grandTotal,
    presets: buildPresetsResponse(quote),
    // NO _internal BLOCK HERE. This route is client-authenticated: anything
    // returned is visible in the browser network tab whether or not the UI
    // renders it. Downstream deadhead, truck numbers and successor markets are
    // fleet posture — they go to the staff routes only (see /api/quote).
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
    // COUNTS ONLY on the client surface. Truck numbers, the markets they are
    // sitting in, and which of them could be freed by displacing a soft hold
    // are all internal fleet posture — the staff quote route returns the
    // detail, a buyer gets the shape of the constraint and nothing more.
    cannotArrive: a.counts.cannotArrive,
    wouldStrandSuccessor: a.counts.wouldStrandSuccessor,
  }
}

/**
 * Deadhead this booking imposes on each selected truck's NEXT job.
 *
 * Flagged, never priced: the successor's transport was already quoted when it
 * was booked and is not re-rated here.
 *
 * INTERNAL ONLY — never include the result in a client-facing response body.
 * On this route it is logged server-side; the staff routes return it.
 */
function buildChainFlags(trucks: { truckNumber: string; chain: { successor: null | { market: string; startsOn: string; deltaTransportDays: number; deltaCost: number; unresolvedMarket: boolean } } }[]) {
  return trucks
    .filter(t => t.chain.successor && !t.chain.successor.unresolvedMarket
      && (t.chain.successor.deltaTransportDays !== 0 || t.chain.successor.deltaCost !== 0))
    .map(t => ({
      truckNumber: t.truckNumber,
      successorMarket: t.chain.successor!.market,
      successorStart: t.chain.successor!.startsOn,
      deltaTransportDays: t.chain.successor!.deltaTransportDays,
      deltaCost: Math.round(t.chain.successor!.deltaCost),
    }))
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

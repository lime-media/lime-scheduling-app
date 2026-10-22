/**
 * The client quote: the client portal's quote form (POST /api/client/quote),
 * moved out of its route so other client surfaces can quote through the same
 * code. Returns the route's status and JSON body.
 *
 * Computes availability (with per-truck transport and travel day blocking),
 * media pricing, and returns per-feature costs for client-side recalculation.
 *
 * Transport is priced by the single engine in lib/pricing/transport.ts — this
 * code measures nothing and decides nothing about transport on its own.
 */

import { getSfdcAccountInfo, isSfdcConfigured } from '@/lib/salesforceClient'
import { brandMarkupFor, withMarkup } from '@/lib/pricing/brandMarkup'
import type { ClientSession } from '@/lib/clientAuth'
import { clientAvailability, parseClientAvailabilityRequest } from '@/lib/clientAvailability'
import { legsFromTrucks, type AvailabilityResult } from '@/lib/availabilityEngine'

import {
  computeQuote,
  priceTransport,
  countActivationDays,
  billedDaysPerWeek,
  VALID_STUDIES,
  type StudyType,
} from '@/lib/pricing'
import { resolveRateOverrides } from '@/lib/pricing/resolvers'
import { liveClientLinks } from '@/lib/clientLinks'
import { reply, type CoreResult } from '@/lib/coreResult'

export type ClientQuoteInput = {
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

export async function clientQuote(session: ClientSession, body: ClientQuoteInput): Promise<CoreResult> {
  const request = body && typeof body === 'object' ? parseClientAvailabilityRequest(body) : null
  if (!request) {
    return reply({ error: 'market, start_date, end_date, and truck_count (>= 1) are required' }, { status: 400 })
  }
  const { start_date, end_date, truck_count } = request


  // Lead time, market, service area and trucks, by the client rules (lib/clientAvailability.ts).
  const checked = await clientAvailability(session, request)
  if (checked.refused) return reply(checked.refused.body, { status: checked.refused.status })
  const { formalMarket, calendarDays, availability, rateOverrides, marketSizeTierId } = checked

  // Schedule configuration:
  // - Campaigns 6 days or less: every day (default days_per_week=7)
  // - Campaigns 7+ days: Mon-Fri schedule (default days_per_week=5)
  // - Client can opt into 6 or 7 day weeks for longer campaigns
  const daysPerWeek = billedDaysPerWeek(start_date, end_date, body.days_per_week)
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

  // Select the best trucks (cheapest chain first, up to requested count).
  // Override-only trucks are excluded here for the same reason they are
  // excluded from `sufficient` — displacing a soft hold is a rep's decision.
  const selectedTrucks = availability.trucks
    .filter(t => !t.requiresOverride)
    .slice(0, truck_count)

  // Brand Direct accounts are priced with the markup folded into every price,
  // at the default rate (clients cannot change it and never see it).
  // Read from the client's row, not the session's 30-day-old copy.
  const { sfdcAccountId } = await liveClientLinks(session)
  const accountInfo = sfdcAccountId && isSfdcConfigured()
    ? await getSfdcAccountInfo(sfdcAccountId).catch(() => null)
    : null
  const markupPct = brandMarkupFor(accountInfo?.clientType)

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
    markupPct,
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
    markupPct,
  })

  const totalTransportCharge = transport.charge

  // Internal signal, server-side only — see buildChainFlags().
  const chainFlags = buildChainFlags(selectedTrucks)
  if (chainFlags.length > 0) {
    console.info('[client/quote] downstream deadhead (not billed):', JSON.stringify(chainFlags))
  }

  // Feature costs
  const featureCosts = buildFeaturesResponse(quote, includeShadowFencing, includeSmartDirectional, includeDeviceId, studies, rateOverrides, markupPct)

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

  return reply({
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

function buildAvailabilityResponse(a: AvailabilityResult) {
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
  markupPct: number,
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
        : quote.input.truckDays * withMarkup(rateOverrides?.smart_directional_daily ?? 250, markupPct),
    },
    deviceId: {
      included: includeDeviceId,
      cost: quote.better.deviceIdIncluded
        ? quote.better.deviceId
        : withMarkup(rateOverrides?.device_id_flat ?? 2500, markupPct),
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


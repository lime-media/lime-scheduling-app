/**
 * The staff quote: availability, pricing and transport for one market, the
 * way the internal /quote page prices it. Called by POST /api/quote; a lib
 * function so the staff AI chat (next PR) quotes through the same code.
 * Returns the route's status and JSON body.
 */

import { getSfdcAccountInfo, isSfdcConfigured } from '@/lib/salesforceClient'
import { brandMarkupFor, withMarkup } from '@/lib/pricing/brandMarkup'
import { checkAvailability, legsFromTrucks, overrideOptions, type AvailabilityResult } from '@/lib/availabilityEngine'
import { insufficientSummary } from '@/lib/quoteAlternatives'
import {
  computeQuote,
  priceTransport,
  countActivationDays,
  billedDaysPerWeek,
  VALID_STUDIES,
  type StudyType,
} from '@/lib/pricing'
import {
  resolveMarketInputAll,
  resolveMarketSizeTierId,
  resolveRateOverridesBySfdcAccount,
  resolveDefaultRateOverrides,
} from '@/lib/pricing/resolvers'

import { SERVICE_AREA_RADIUS_MILES, type RateOverrides } from '@/lib/pricing/config'
import { reply, type CoreResult } from '@/lib/coreResult'

export type StaffQuoteInput = {
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
  /** Seller's Brand Direct markup; applied only if Salesforce says the account is Brand Direct. */
  brand_markup_pct?: number
  /** Price it even without enough trucks — it can then only be logged as a quote, never reserved. */
  quote_only?: boolean
}

export async function staffQuote(body: StaffQuoteInput): Promise<CoreResult> {
  const { market, start_date, end_date, truck_count } = body
  if (!market || !start_date || !end_date || !truck_count || truck_count < 1) {
    return reply({ error: 'market, start_date, end_date, and truck_count (>= 1) are required' }, { status: 400 })
  }

  // Market resolution
  // Resolve against the hardcoded map AND the 356-market list the team
  // maintains — /api/markets autocompletes from the latter, so gating on the
  // former would reject markets the rep just picked from the dropdown.
  const marketMatches = await resolveMarketInputAll(market)
  if (marketMatches.length === 0) {
    return reply({
      error: `We couldn't find "${market}". Use a US city with its state (e.g. "Ames, IA") or a ZIP code.`,
    }, { status: 400 })
  }
  if (marketMatches.length > 1) {
    return reply({
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
    return reply({
      error: `We currently only serve markets within the contiguous 48 states. ${formalMarket} is outside our service area.`,
    }, { status: 400 })
  }

  const startDate = new Date(start_date + 'T00:00:00Z')
  const endDate = new Date(end_date + 'T00:00:00Z')
  const calendarDays = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1
  if (!Number.isFinite(calendarDays) || calendarDays < 1) {
    return reply({ error: 'Invalid date range' }, { status: 400 })
  }

  const daysPerWeek = billedDaysPerWeek(start_date, end_date, body.days_per_week)
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
      // Staff: leaving a later AT&T soft hold short is a warning, not a block.
      softHoldStrandIsWarning: true,
    }),
    resolveMarketSizeTierId(formalMarket),
  ])

  // Only two reasons to refuse: market outside the service area, or no truck
  // can physically reach it. Truck count is never a reason on its own.
  if (!availability.marketResolved) {
    return reply({
      availability: {
        requested: truck_count, available: 0, local: 0, nearby: 0,
        repositioning: 0, sufficient: false,
      },
      insufficient: true,
      outOfServiceArea: true,
      message: `Could not locate "${formalMarket}" — Lime Media serves the contiguous 48 states.`,
      detail: 'No coordinates could be resolved for this market, so no truck distance could be computed.',
    })
  }

  if (!availability.sufficient && body.quote_only !== true) {
    const summary = insufficientSummary({
      market: formalMarket, start: start_date, end: end_date, requested: truck_count,
      free: availability.counts.total,
      releasable: availability.trucks.filter(t => t.softHoldOnDates).length,
      options: availability.dateOptions,
    })
    return reply({
      availability: {
        // Trucks an AT&T soft-hold release would free: the way out of "not
        // enough trucks" when the nearby ones are soft-held.
        requiresOverride: overrideOptions(availability),
        requested: truck_count,
        available: availability.counts.total,
        local: availability.counts.local,
        nearby: availability.counts.nearby,
        repositioning: availability.counts.repositioning,
        sufficient: false,
        excluded: excludedTrucks(availability),
        dateOptions: availability.dateOptions,
      },
      insufficient: true,
      message: summary.message,
      detail: summary.detail,
    })
  }

  const selectedTrucks = availability.trucks
    .filter(t => !t.requiresOverride)
    .slice(0, truck_count)

  // Brand Direct: folded into every price (see lib/pricing/brandMarkup.ts).
  const accountInfo = body.sfdc_account_id && isSfdcConfigured()
    ? await getSfdcAccountInfo(body.sfdc_account_id).catch((err) => { console.error('[quote] account lookup failed:', err); return null })
    : null
  const markupPct = brandMarkupFor(accountInfo?.clientType, body.brand_markup_pct)

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

  return reply({
    availability: {
      requested: truck_count,
      available: availability.counts.total,
      local: availability.counts.local,
      nearby: availability.counts.nearby,
      repositioning: availability.counts.repositioning,
      // The free-transport radius this quote used (a rate agreement may change it).
      serviceAreaMiles: rateOverrides?.service_area_miles ?? SERVICE_AREA_RADIUS_MILES,
      sufficient: true,
      cannotArrive: availability.counts.cannotArrive,
      wouldStrandSuccessor: availability.counts.wouldStrandSuccessor,
      originFellBackToGps: availability.counts.originFellBackToGps,
      gpsFallbackMarkets: [...new Set(
        availability.trucks
          .map(t => t.chain.inbound.originFellBackToGps)
          .filter((m): m is string => Boolean(m)),
      )],
      excluded: excludedTrucks(availability),
      // Selected trucks that leave a later AT&T soft hold short (staff rule:
      // allowed, flagged).
      softHoldWarnings: selectedTrucks
        .filter(t => t.softHoldWarning)
        .map(t => ({ truckNumber: t.truckNumber, warning: t.softHoldWarning! })),
      requiresOverride: overrideOptions(availability),
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
      // Internal page only: the Brand Direct markup folded into every price above.
      clientType: accountInfo?.clientType ?? null,
      // Not enough trucks free: priced on request, and can only be logged as a
      // quote (no reservation). Transport covers only the trucks that are free.
      quoteOnlyRequired: !availability.sufficient,
      brandMarkupPct: markupPct,
      marketSizeTier: quote.input.marketSizeTier,
      schedule: { daysPerWeek, operatingHours, activationDays: days },
    },
    features: {
      shadowFencing: { included: includeShadowFencing, cost: quote.better.shadowFencing, floored: quote.better.shadowFencingFloored, digitalImpressions: quote.better.digitalImpressions },
      smartDirectional: { included: includeSmartDirectional, cost: includeSmartDirectional ? quote.better.smartDirectional : quote.input.truckDays * withMarkup(rateOverrides?.smart_directional_daily ?? 250, markupPct) },
      deviceId: { included: includeDeviceId, cost: includeDeviceId ? quote.better.deviceId : withMarkup(rateOverrides?.device_id_flat ?? 2500, markupPct) },
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

/** Trucks that cannot take the campaign, with why and the dates they could do. */
function excludedTrucks(availability: AvailabilityResult) {
  return availability.infeasible.map(t => ({
    truckNumber: t.truckNumber,
    from: t.currentMarket || 'Unknown',
    reason: t.reason,
    detail: t.detail,
    earliestStart: t.earliestStart ?? null,
    latestEnd: t.latestEnd ?? null,
  }))
}


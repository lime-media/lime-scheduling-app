/**
 * Internal quote API — same pricing logic as the client-facing
 * POST /api/client/quote, but authenticated via NextAuth (internal staff)
 * and accepts a sfdc_account_id for Salesforce opportunity creation.
 *
 * This endpoint is used by the internal /quote page.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { checkAvailability } from '@/lib/availabilityEngine'
import {
  computeQuote,
  VALID_STUDIES,
  type StudyType,
} from '@/lib/pricing'
import {
  resolveMarketSizeTierId,
} from '@/lib/pricing/resolvers'
import { resolveMarketInput } from '@/lib/marketCoordinates'

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

  const defaultDaysPerWeek = calendarDays <= 6 ? 7 : 5
  const daysPerWeek = body.days_per_week ?? defaultDaysPerWeek
  const operatingHours = body.operating_hours ?? 8

  // Count activation days
  function countActivationDays(startStr: string, endStr: string, dpw: number): number {
    if (dpw === 7) {
      const s = new Date(startStr + 'T00:00:00Z'), e = new Date(endStr + 'T00:00:00Z')
      return Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1
    }
    let count = 0
    const c = new Date(startStr + 'T00:00:00Z'), e = new Date(endStr + 'T00:00:00Z')
    while (c <= e) {
      const dow = c.getUTCDay()
      if (dpw === 5 && dow >= 1 && dow <= 5) count++
      else if (dpw === 6 && dow >= 1 && dow <= 6) count++
      c.setUTCDate(c.getUTCDate() + 1)
    }
    return count
  }

  const days = countActivationDays(start_date, end_date, daysPerWeek)

  const studies = (body.studies ?? [])
    .map(s => s.trim().toLowerCase())
    .filter((s): s is StudyType => (VALID_STUDIES as readonly string[]).includes(s))

  const includeShadowFencing = body.shadow_fencing !== false
  const includeSmartDirectional = body.smart_directional ?? false
  const includeDeviceId = body.device_id ?? false

  const [availability, marketSizeTierId] = await Promise.all([
    checkAvailability({
      market: formalMarket,
      startDate: start_date,
      endDate: end_date,
      truckCount: truck_count,
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
  })

  const repoTrucks = selectedTrucks.filter(t => t.transport.needed)
  const localTrucks = selectedTrucks.filter(t => !t.transport.needed)

  const MIN_DAYS_TO_ABSORB = 10
  const MIN_LEAD_DAYS_TO_ABSORB = 10
  const leadBusinessDays = availability.campaignFlags.leadBusinessDays
  const transportAbsorbed = days >= MIN_DAYS_TO_ABSORB && leadBusinessDays >= MIN_LEAD_DAYS_TO_ABSORB
  const totalTransportCharge = transportAbsorbed
    ? 0
    : repoTrucks.reduce((sum, t) => sum + t.transport.chargePerTruck, 0)

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
      pricingBasis: quote.pricingBasis,
      marketSizeTier: quote.input.marketSizeTier,
      schedule: { daysPerWeek, operatingHours, activationDays: days },
    },
    features: {
      shadowFencing: { included: includeShadowFencing, cost: quote.better.shadowFencing, floored: quote.better.shadowFencingFloored, digitalImpressions: quote.better.digitalImpressions },
      smartDirectional: { included: includeSmartDirectional, cost: includeSmartDirectional ? quote.better.smartDirectional : quote.input.truckDays * 250 },
      deviceId: { included: includeDeviceId, cost: includeDeviceId ? quote.better.deviceId : 2500 },
      studies: { available: quote.best.reachOk, selected: studies, costPerStudy: quote.best.studyCost, estimatedImpressions: quote.best.estimatedImpressions, reachMinimum: 1_200_000 },
    },
    transport: {
      outcome: repoTrucks.length === 0 ? 'INCLUDED' : transportAbsorbed ? 'ABSORBED' : 'BILLED',
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

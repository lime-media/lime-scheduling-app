/**
 * Shared resolver functions for market tier, rate agreements, and nearest
 * accepted market lookups. Extracted from app/api/client/chat/route.ts so
 * they can be reused by the direct quote API and availability engine.
 */

import { prisma } from '@/lib/prisma'
import { haversineDistance, getMarketCoords } from '@/lib/marketCoordinates'
import { marketSizeTierFromDmaCode, type RateOverrides } from './config'
import type { ClientSession } from '@/lib/clientAuth'

// ---------------------------------------------------------------------------
// Market size tier
// ---------------------------------------------------------------------------

/**
 * Resolve a campaign market string (e.g. "Dallas, TX") to a market size
 * tier ID (1-4) by matching against active AcceptedMarkets in the DB.
 * Falls back to tier 3 (mid/large) if no match — safe default that
 * doesn't over-promise on lift-study eligibility.
 */
export async function resolveMarketSizeTierId(market: string): Promise<number> {
  if (!market) return 3
  try {
    const acceptedMarkets = await prisma.acceptedMarket.findMany({
      where: { is_active: true },
      select: { dma_code: true, dma_name: true },
    })
    const marketLower = market.toLowerCase()
    const matched = acceptedMarkets.find((am) => {
      const dmaCity = am.dma_name.split(',')[0].trim().toLowerCase()
      const reqCity = marketLower.split(',')[0].trim()
      return dmaCity === reqCity || marketLower.includes(dmaCity) || dmaCity.includes(reqCity)
    })
    return matched ? marketSizeTierFromDmaCode(matched.dma_code) : 3
  } catch (err) {
    console.error('[resolvers] market size tier lookup failed, using default tier 3:', err)
    return 3
  }
}

// ---------------------------------------------------------------------------
// Rate agreement
// ---------------------------------------------------------------------------

/**
 * Look up an active RateAgreement for a client session's partner_id.
 * Returns null (standard rate card) if the client has no partner_id or
 * no active agreement. A lookup failure also falls back to standard
 * pricing — never blocks a quote.
 */
export async function resolveRateOverrides(session: ClientSession): Promise<RateOverrides | null> {
  if (!session.partnerId) return null
  try {
    const now = new Date()
    const agreement = await prisma.rateAgreement.findFirst({
      where: {
        partner_id:      session.partnerId,
        effective_date:  { lte: now },
        expiration_date: { gte: now },
      },
      orderBy: { created_at: 'desc' },
    })
    return agreement ? (JSON.parse(agreement.rate_overrides) as RateOverrides) : null
  } catch (err) {
    console.error('[resolvers] rate agreement lookup failed, using standard rate card:', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Campaign coordinate resolution
// ---------------------------------------------------------------------------

export type CampaignCoords = { lat: number; lng: number; source: 'coords_map' | 'accepted_market' }

/**
 * Resolve a campaign market string to lat/lng coordinates.
 *
 * Tries in order:
 * 1. Hardcoded COORDS map (282 US cities) via getMarketCoords()
 * 2. AcceptedMarket table (50 DMAs) — fuzzy city-name match
 *
 * Returns null only if neither source recognizes the market.
 */
export async function resolveCampaignCoords(market: string): Promise<CampaignCoords | null> {
  // Try the hardcoded 282-city map first
  const fromMap = getMarketCoords(market)
  if (fromMap) return { ...fromMap, source: 'coords_map' }

  // Fall back to accepted markets table (fuzzy city match)
  try {
    const acceptedMarkets = await prisma.acceptedMarket.findMany({
      where: { is_active: true },
      select: { dma_name: true, lat: true, lng: true },
    })
    const marketLower = market.toLowerCase()
    const reqCity = marketLower.split(',')[0].trim()

    const matched = acceptedMarkets.find((am) => {
      const dmaCity = am.dma_name.split(',')[0].trim().toLowerCase()
      return dmaCity === reqCity || marketLower.includes(dmaCity) || dmaCity.includes(reqCity)
    })

    if (matched) return { lat: matched.lat, lng: matched.lng, source: 'accepted_market' }
  } catch (err) {
    console.error('[resolvers] accepted market coord fallback failed:', err)
  }

  console.warn('[resolvers] could not resolve coordinates for market:', market)
  return null
}

// ---------------------------------------------------------------------------
// Nearest accepted market
// ---------------------------------------------------------------------------

export type NearestMarketResult = {
  dma_name: string
  dma_code: string
  distanceMiles: number
  baseConcurrency: number
  lat: number
  lng: number
}

/**
 * Find the nearest active AcceptedMarket to a given lat/lng.
 * Uses haversine distance, matching the internal quote route's logic.
 */
export async function resolveNearestAcceptedMarket(
  campaignLat: number,
  campaignLng: number,
): Promise<NearestMarketResult | null> {
  try {
    const acceptedMarkets = await prisma.acceptedMarket.findMany({
      where: { is_active: true },
    })
    if (acceptedMarkets.length === 0) return null

    let nearest = acceptedMarkets[0]
    let nearestDist = Infinity

    for (const market of acceptedMarkets) {
      const dist = haversineDistance(campaignLat, campaignLng, market.lat, market.lng)
      if (dist < nearestDist) {
        nearestDist = dist
        nearest = market
      }
    }

    return {
      dma_name: nearest.dma_name,
      dma_code: nearest.dma_code,
      distanceMiles: Math.round(nearestDist * 10) / 10,
      baseConcurrency: nearest.base_concurrency,
      lat: nearest.lat,
      lng: nearest.lng,
    }
  } catch (err) {
    console.error('[resolvers] nearest accepted market lookup failed:', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Business days
// ---------------------------------------------------------------------------

/**
 * Count weekdays (Mon-Fri) between two dates, exclusive of both endpoints.
 * Used for the transport absorption threshold (10+ business days lead time).
 *
 * Both dates are normalized to UTC midnight to avoid timezone drift —
 * new Date() in US timezones is behind UTC, which could add a phantom
 * business day when compared against a UTC midnight campaign start date.
 */
export function businessDaysBetween(from: Date, to: Date): number {
  // Normalize both to UTC date-only (strip time component)
  const fromUTC = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()))
  const toUTC = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()))

  let count = 0
  const current = new Date(fromUTC)
  current.setUTCDate(current.getUTCDate() + 1) // start from day after 'from'

  while (current < toUTC) {
    const day = current.getUTCDay()
    if (day !== 0 && day !== 6) count++
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return count
}

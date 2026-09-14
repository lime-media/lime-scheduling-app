/**
 * Shared resolver functions for market tier, rate agreements, and nearest
 * accepted market lookups. Extracted from app/api/client/chat/route.ts so
 * they can be reused by the direct quote API and availability engine.
 */

import { prisma } from '@/lib/prisma'
import { haversineDistance, getMarketCoords, resolveMarketInput, type MarketMatch } from '@/lib/marketCoordinates'
import { marketSizeTierFromDmaCode, type RateOverrides } from './config'
import { loadStandardMarketCoords, normalizeMarketKey } from '@/lib/marketBounds'
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
  // Try sfdc_account_id first (canonical), fall back to partner_id (legacy)
  const sfdcAccountId = session.sfdcAccountId
  const partnerId = session.partnerId
  if (!sfdcAccountId && !partnerId) return null
  try {
    const now = new Date()
    const agreement = await prisma.rateAgreement.findFirst({
      where: {
        ...(sfdcAccountId
          ? { sfdc_account_id: sfdcAccountId }
          : { partner_id: partnerId! }),
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

/**
 * Look up rate overrides by Salesforce Account ID directly (for internal quote flows
 * where there's no client session).
 */
export const DEFAULT_RATE_CARD_SFDC_ID = '__default__'

/**
 * Load the editable default rate card (sfdc_account_id = '__default__').
 * Returns null if none exists — the hardcoded config.ts values apply.
 */
export async function resolveDefaultRateOverrides(): Promise<RateOverrides | null> {
  try {
    const now = new Date()
    const agreement = await prisma.rateAgreement.findFirst({
      where: {
        sfdc_account_id: DEFAULT_RATE_CARD_SFDC_ID,
        effective_date:  { lte: now },
        expiration_date: { gte: now },
      },
      orderBy: { created_at: 'desc' },
    })
    return agreement ? (JSON.parse(agreement.rate_overrides) as RateOverrides) : null
  } catch {
    return null
  }
}

export async function resolveRateOverridesBySfdcAccount(sfdcAccountId: string): Promise<{ overrides: RateOverrides | null; agreementName?: string }> {
  try {
    const now = new Date()
    // Direct lookup by sfdc_account_id on the rate agreement
    let agreement = await prisma.rateAgreement.findFirst({
      where: {
        sfdc_account_id: sfdcAccountId,
        effective_date:  { lte: now },
        expiration_date: { gte: now },
      },
      orderBy: { created_at: 'desc' },
    })
    // Legacy fallback: look up via ClientUser.partner_id
    if (!agreement) {
      const clientUser = await prisma.clientUser.findFirst({
        where: { sfdc_account_id: sfdcAccountId },
        select: { partner_id: true },
      })
      if (clientUser?.partner_id) {
        agreement = await prisma.rateAgreement.findFirst({
          where: {
            partner_id: clientUser.partner_id,
            effective_date: { lte: now },
            expiration_date: { gte: now },
          },
          orderBy: { created_at: 'desc' },
        })
      }
    }
    if (!agreement) return { overrides: null }
    return {
      overrides: JSON.parse(agreement.rate_overrides) as RateOverrides,
      agreementName: agreement.name,
    }
  } catch (err) {
    console.error('[resolvers] rate agreement lookup by SFDC account failed:', err)
    return { overrides: null }
  }
}

// ---------------------------------------------------------------------------
// Campaign coordinate resolution
// ---------------------------------------------------------------------------

export type CampaignCoords = { lat: number; lng: number; source: 'coords_map' | 'standard_market' | 'accepted_market' }

/**
 * Resolve a campaign market string to lat/lng coordinates.
 *
 * Tries in order:
 * 1. Hardcoded COORDS map (281 US cities) via getMarketCoords()
 * 2. standard_market_lookup (356 markets) — the list the team maintains, and
 *    the only one that covers what they can actually schedule. The hardcoded
 *    map covers 61% of it.
 * 3. AcceptedMarket table (50 DMAs) — fuzzy city-name match
 *
 * Returns null only if no source recognizes the market.
 */
export async function resolveCampaignCoords(market: string): Promise<CampaignCoords | null> {
  // Try the hardcoded city map first — no query, and it covers the common cases
  const fromMap = getMarketCoords(market)
  if (fromMap) return { ...fromMap, source: 'coords_map' }

  // Then the authoritative market list, which covers everything schedulable
  try {
    const standardMarkets = await loadStandardMarketCoords()
    const key = normalizeMarketKey(market)
    const exact = standardMarkets.get(key)
    if (exact) return { ...exact, source: 'standard_market' }

    // City-only match, for "Allentown" against "Allentown, PA"
    const city = key.split(',')[0].trim()
    if (city) {
      for (const [name, coords] of standardMarkets) {
        if (name.split(',')[0].trim() === city) {
          return { ...coords, source: 'standard_market' }
        }
      }
    }
  } catch (err) {
    console.error('[resolvers] standard market coord lookup failed:', err)
  }

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

// ---------------------------------------------------------------------------
// Market input resolution across BOTH sources
// ---------------------------------------------------------------------------

/**
 * Resolve typed/selected market text against everything we know.
 *
 * resolveMarketInput() alone searches the 281-entry hardcoded file, which is
 * the gate both quote routes run before anything else. /api/markets, meanwhile,
 * autocompletes from the real 356-market list — so a rep could pick a valid
 * market from the dropdown and be told it does not exist. This closes that.
 *
 * The standard market list wins on ties: it is the list the team maintains and
 * the one every scheduled shift is selected from, so its spelling is canonical.
 */
export async function resolveMarketInputAll(input: string): Promise<MarketMatch[]> {
  const fromFile = resolveMarketInput(input)

  let standard: Map<string, { lat: number; lng: number }>
  try {
    standard = await loadStandardMarketCoords()
  } catch (err) {
    console.error('[resolvers] standard market list unavailable, file only:', err)
    return fromFile
  }
  if (standard.size === 0) return fromFile

  const key = normalizeMarketKey(input)
  const city = key.split(',')[0].trim()
  const state = key.split(',')[1]?.trim()

  const exact: MarketMatch[] = []
  const cityMatches: MarketMatch[] = []
  const prefixMatches: MarketMatch[] = []

  for (const [name, coords] of standard) {
    const nameCity = name.split(',')[0].trim()
    const nameState = name.split(',')[1]?.trim()
    const match: MarketMatch = { key: name, formal: formalizeMarketName(name), ...coords }

    if (name === key) exact.push(match)
    else if (city && nameCity === city && (!state || nameState === state)) cityMatches.push(match)
    else if (city && nameCity.startsWith(city) && (!state || nameState === state)) prefixMatches.push(match)
  }

  const tier = exact.length ? exact : cityMatches.length ? cityMatches : prefixMatches

  // Merge, preferring the standard market list where both know a market.
  const byKey = new Map<string, MarketMatch>()
  for (const m of tier) byKey.set(m.key, m)
  for (const m of fromFile) if (!byKey.has(m.key)) byKey.set(m.key, m)

  return [...byKey.values()].sort((a, b) => a.formal.localeCompare(b.formal))
}

/** Title-case a "city, st" key for display: "allentown, pa" -> "Allentown, PA". */
function formalizeMarketName(key: string): string {
  const [city, state] = key.split(',').map(p => p.trim())
  const titled = city.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  return state ? `${titled}, ${state.toUpperCase()}` : titled
}

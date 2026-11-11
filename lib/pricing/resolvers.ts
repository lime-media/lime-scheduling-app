/**
 * Shared resolver functions for market tier, rate agreements and campaign
 * coordinates. Extracted from app/api/client/chat/route.ts so
 * they can be reused by the direct quote API and availability engine.
 */

import { prisma } from '@/lib/prisma'
import { getMarketCoords, resolveMarketInput, type MarketMatch } from '@/lib/marketCoordinates'
import { marketSizeTierFromDmaCode, NON_DMA_MARKET_TIER, type RateOverrides } from './config'
import { loadStandardMarketCoords, normalizeMarketKey, titleCaseMarket } from '@/lib/marketBounds'
import { findPlaces, placeCoords, withStateComma } from '@/lib/geo/places'
import { dmaForPoint } from '@/lib/pricing/dmaArea'
import { TOP_DMAS } from '@/lib/pricing/topDmas'
import type { ClientSession } from '@/lib/clientAuth'
import { liveClientLinks } from '@/lib/clientLinks'
import { stateCode } from '@/lib/usStates'

// ---------------------------------------------------------------------------
// Market size tier
// ---------------------------------------------------------------------------

/**
 * Resolve a campaign market string (e.g. "Dallas, TX") to a market size
 * tier ID (1-4): a top-50 DMA city by name, else the top-50 DMA whose ring
 * the market sits in (lib/pricing/dmaArea.ts), else tier 4 (small metro).
 * Tier sets estimated reach, and so lift-study eligibility — never price.
 */
export async function resolveMarketSizeTierId(market: string, knownCoords?: { lat: number; lng: number } | null): Promise<number> {
  if (!market) return NON_DMA_MARKET_TIER
  try {
    // A top-50 DMA city by name, then by location: a suburb in a top-50 DMA's
    // ring takes that DMA's tier (lib/pricing/dmaArea.ts).
    const named = matchTopDma(market, TOP_DMAS)
    if (named) return marketSizeTierFromDmaCode(named.dma_code)
    // Callers that already located the market pass its coordinates.
    const coords = knownCoords ?? await resolveCampaignCoords(market)
    const around = coords ? dmaForPoint(coords, TOP_DMAS) : null
    return around ? marketSizeTierFromDmaCode(around.dma_code) : NON_DMA_MARKET_TIER
  } catch (err) {
    console.error('[resolvers] market size tier lookup failed, using the small-metro tier:', err)
    return NON_DMA_MARKET_TIER
  }
}

/**
 * Match a market against the top-50 DMAs (lib/pricing/topDmas.ts).
 *
 * Deliberately stricter than the old substring test, which matched in BOTH
 * directions (`market.includes(dmaCity) || dmaCity.includes(reqCity)`). That
 * made "York, PA" match the New York DMA and jump from tier 4 to tier 1 —
 * a 4.5x impressions error from a substring. Now: same city, and same state
 * when both state it.
 */
export function matchTopDma<T extends { dma_code: string; dma_name: string }>(
  market: string,
  dmas: readonly T[],
): T | undefined {
  const key = normalizeMarketKey(market)
  const city = key.split(',')[0].trim()
  const state = key.split(',')[1]?.trim()
  if (!city) return undefined

  return dmas.find((am) => {
    const dmaKey = normalizeMarketKey(am.dma_name)
    const dmaCity = dmaKey.split(',')[0].trim()
    const dmaState = dmaKey.split(',')[1]?.trim()
    if (dmaCity !== city) return false
    return !state || !dmaState || state === dmaState
  })
}

// ---------------------------------------------------------------------------
// Rate agreement
// ---------------------------------------------------------------------------

/**
 * Look up an active RateAgreement for a client's partner_id.
 * Returns null (standard rate card) if the client has no partner_id or
 * no active agreement. A lookup failure also falls back to standard
 * pricing — never blocks a quote.
 *
 * The links are re-read from the client's row, not taken from the session's
 * copies: a session lasts 30 days, and an ops correction has to apply to the
 * next quote, not the next login (lib/clientLinks.ts).
 */
export async function resolveRateOverrides(session: ClientSession): Promise<RateOverrides | null> {
  // Try sfdc_account_id first (canonical), fall back to partner_id (legacy)
  const { sfdcAccountId, partnerId } = await liveClientLinks(session)
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

/**
 * A client's rate card: their agreement over the editable default card
 * (daily rates merged market by market), or the default card alone. The one
 * merge every client quote and booking prices on, so the portal's quote, its
 * booking and the multi-market order agree.
 */
export async function clientRateCard(session: ClientSession): Promise<{ overrides: RateOverrides | null; agreement: boolean }> {
  const [clientOverrides, defaultOverrides] = await Promise.all([resolveRateOverrides(session), resolveDefaultRateOverrides()])
  return clientOverrides
    ? { overrides: { ...defaultOverrides, ...clientOverrides, daily_rates: { ...defaultOverrides?.daily_rates, ...clientOverrides.daily_rates } }, agreement: true }
    : { overrides: defaultOverrides, agreement: false }
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

export type CampaignCoords = { lat: number; lng: number; source: 'coords_map' | 'standard_market' | 'us_place' | 'top_dma' }

/**
 * A market's place on the standard market list: its exact entry, or, when the
 * market names no state ("Allentown"), the entry with that city name. Sorted so
 * an ambiguous city resolves the same way every time rather than following Map
 * insertion order.
 *
 * A market that names a state matches only in that state ("Dallas, TX 75201"
 * and "Dallas, TX, USA" still find "Dallas, TX"). The city-only match used to
 * ignore the state, so "Dallas, PA" was placed at "Dallas, TX" (and
 * "Canton, TX" in Ohio): wrong distances, transport and impressions tier. Such
 * a town falls through to the US place list instead. Pure.
 */
export function standardMarketCoords<T>(market: string, standardMarkets: ReadonlyMap<string, T>): T | null {
  // Exact entry, as typed or with its state comma'd ("Dallas TX"). The list
  // keys plain names, so an entry like "Northern NJ" is found as typed.
  const key = normalizeMarketKey(withStateComma(market))
  const exact = standardMarkets.get(normalizeMarketKey(market)) ?? standardMarkets.get(key)
  if (exact) return exact
  const { city, state } = marketCityState(key)
  if (!city) return null
  // A stated state matches only entries in that state, never one naming none.
  // No state ("Allentown"): any entry with the city's name.
  const hit = [...standardMarkets.entries()]
    .map(([name, value]) => ({ name, value, ...marketCityState(name) }))
    .filter(h => h.city === city && (!state || h.state === state))
    .sort((a, b) => a.name.localeCompare(b.name))[0]
  return hit ? hit.value : null
}

/**
 * A normalized market name's city and state, read the same way for market
 * text and list entries. Dots dropped, so "St. Louis" is "St Louis" and
 * "Washington, D.C." is in DC. The state is the text after the comma as a code
 * or a full name ("Texas", "New York"); a ZIP or ", USA" may follow it, and a
 * ZIP or a country alone ("Allentown, 18101", "Dallas, USA") names no state.
 * Other text there ("Dallas, Tex") is kept as the state, so it never takes
 * another state's entry. Pure.
 */
export function marketCityState(name: string): { city: string; state: string | undefined } {
  const [city, rest = ''] = name.replace(/\./g, '').split(',').map(p => p.trim())
  const head = rest.replace(/\s*\d[\d-]*$/, '').trim()
  const first = rest.split(' ')[0]
  const isCountry = /^(usa?|united states( of america)?|america)$/i.test(head)
  const s = stateCode(head) || stateCode(first) || (first && !/^\d/.test(first) && !isCountry ? first : '')
  return { city, state: s ? s.toLowerCase() : undefined }
}

/**
 * Resolve a campaign market string to lat/lng coordinates.
 *
 * Tries in order:
 * 1. Hardcoded COORDS map (281 US cities) via getMarketCoords()
 * 2. standard_market_lookup (every standard market) — the list the team maintains, and
 *    the only one that covers what they can actually schedule. The hardcoded
 *    map covers 61% of it.
 * 3. Any US city, town or ZIP (lib/geo/places.ts)
 * 4. A top-50 DMA's own name (lib/pricing/topDmas.ts)
 *
 * Returns null only if no source recognizes the market.
 */
export async function resolveCampaignCoords(market: string): Promise<CampaignCoords | null> {
  // Try the hardcoded city map first — no query, and it covers the common cases
  const fromMap = getMarketCoords(market)
  if (fromMap) return { ...fromMap, source: 'coords_map' }

  // Then the authoritative market list, which covers everything schedulable
  try {
    const standard = standardMarketCoords(market, await loadStandardMarketCoords())
    if (standard) return { ...standard, source: 'standard_market' }
  } catch (err) {
    console.error('[resolvers] standard market coord lookup failed:', err)
  }

  // Any US city, town or ZIP the lists do not know (lib/geo/places.ts).
  // A state written in full or followed by a ZIP ("Canton, Texas",
  // "Dallas, PA 18612") is looked up by its city and state code.
  const named = marketCityState(normalizeMarketKey(withStateComma(market)))
  const place = placeCoords(market) ??
    (named.city && named.state && stateCode(named.state) ? placeCoords(named.city, named.state) : null)
  if (place) return { lat: place.lat, lng: place.lng, source: 'us_place' }

  // Last, a top-50 DMA's own name ("Dallas-Fort Worth, TX"), matched strictly:
  // a looser match placed "South Portland" in Oregon. Text naming no city or
  // town ("Greater Boston Area") is not located, and the quote says so.
  const dma = matchTopDma(market, TOP_DMAS)
  if (dma) return { lat: dma.lat, lng: dma.lng, source: 'top_dma' }

  console.warn('[resolvers] could not resolve coordinates for market:', market)
  return null
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
 * autocompletes from the real standard market list — so a rep could pick a valid
 * market from the dropdown and be told it does not exist. This closes that.
 *
 * The standard market list wins on ties: it is the list the team maintains and
 * the one every scheduled shift is selected from, so its spelling is canonical.
 */
export async function resolveMarketInputAll(rawInput: string): Promise<MarketMatch[]> {
  // "Ames IA" is "Ames, IA": every list below keys markets as "city, st".
  const input = withStateComma(rawInput)
  const fromFile = resolveMarketInput(input)

  let standard: Map<string, { lat: number; lng: number }>
  try {
    standard = await loadStandardMarketCoords()
  } catch (err) {
    console.error('[resolvers] standard market list unavailable, file only:', err)
    return fromFile.length ? fromFile : placeMatches(input)
  }
  if (standard.size === 0) return fromFile.length ? fromFile : placeMatches(input)

  const key = normalizeMarketKey(input)
  const city = key.split(',')[0].trim()
  const state = key.split(',')[1]?.trim()

  const exact: MarketMatch[] = []
  const cityMatches: MarketMatch[] = []
  const prefixMatches: MarketMatch[] = []

  for (const [name, coords] of standard) {
    const nameCity = name.split(',')[0].trim()
    const nameState = name.split(',')[1]?.trim()
    const match: MarketMatch = { key: name, formal: titleCaseMarket(name), ...coords }

    if (name === key) exact.push(match)
    else if (city && nameCity === city && (!state || nameState === state)) cityMatches.push(match)
    else if (city && nameCity.startsWith(city) && (!state || nameState === state)) prefixMatches.push(match)
  }

  const tier = exact.length ? exact : cityMatches.length ? cityMatches : prefixMatches

  // Merge, preferring the standard market list where both know a market.
  const byKey = new Map<string, MarketMatch>()
  for (const m of tier) byKey.set(m.key, m)
  for (const m of fromFile) if (!byKey.has(m.key)) byKey.set(m.key, m)
  // Neither knows it: any US city, town or ZIP (lib/geo/places.ts).
  if (byKey.size === 0) return placeMatches(input)

  return [...byKey.values()].sort((a, b) => a.formal.localeCompare(b.formal))
}


/** Places as market matches: the fallback when no market list knows the input. */
function placeMatches(input: string): MarketMatch[] {
  return findPlaces(input).map(p => ({ key: normalizeMarketKey(p.name), formal: p.name, lat: p.lat, lng: p.lng }))
}

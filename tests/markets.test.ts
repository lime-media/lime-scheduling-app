/**
 * Market name matching — the rule that decides whether a hold, a typed campaign
 * market, or a reverse-geocoded GPS city resolves to a canonical market.
 *
 * Pure functions only; the database-backed wrappers around them
 * (hasMarketBounds, loadStandardMarketCoords) need a live connection and are
 * not covered here.
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { matchMarketKey, titleCaseMarket, normalizeMarketKey } from '@/lib/marketBounds'
import { matchAcceptedDma } from '@/lib/pricing/resolvers'
import { validateEmailList } from '@/lib/appSettings'
import { boxIsWhereItsCityIs, pickStandardMarket, type StandardMarket } from '@/lib/standardMarkets'
import { marketSizeTierFromDmaCode, NON_DMA_MARKET_TIER, MARKET_SIZE_TIERS } from '@/lib/pricing/config'

// A stand-in for standard_market_lookup, including the shapes that caused bugs:
// duplicate city names across states, and multi-word cities.
const KEYS = [
  'dallas, tx',
  'miami, fl',
  'doral, fl',
  'north palm beach, fl',
  'portland, or',
  'portland, me',
  'columbia, sc',
  'columbia, mo',
  'new york, ny',
]

section('exact and state-appended matching')
eq('exact key', matchMarketKey('Dallas, TX', 'TX', KEYS), 'dallas, tx')
eq('case and spacing normalized', matchMarketKey('  DALLAS ,tx ', 'TX', KEYS), 'dallas, tx')
eq('state appended when absent', matchMarketKey('Dallas', 'TX', KEYS), 'dallas, tx')
eq('state not doubled when present', matchMarketKey('Dallas, TX', 'TX', KEYS), 'dallas, tx')
eq('multi-word city', matchMarketKey('North Palm Beach, FL', 'FL', KEYS), 'north palm beach, fl')

section('city-only matching requires uniqueness')
eq('unique city resolves without a state', matchMarketKey('Miami', undefined, KEYS), 'miami, fl')
eq('ambiguous city returns null, not a guess', matchMarketKey('Portland', undefined, KEYS), null)
eq('ambiguous city resolves with a state', matchMarketKey('Portland', 'OR', KEYS), 'portland, or')
eq('second ambiguous city also null', matchMarketKey('Columbia', undefined, KEYS), null)

section('non-matches')
eq('unknown market', matchMarketKey('Springfield, IL', 'IL', KEYS), null)
eq('empty input', matchMarketKey('', 'TX', KEYS), null)
eq('whitespace input', matchMarketKey('   ', undefined, KEYS), null)
// A stated state is a constraint. Falling back to Dallas, TX here would
// silently relocate a campaign a thousand miles.
eq('wrong state rules out an exact city', matchMarketKey('Dallas, GA', 'GA', KEYS), null)
eq('wrong state via the state arg alone', matchMarketKey('Dallas', 'GA', KEYS), null)
eq('right state still resolves', matchMarketKey('Dallas', 'TX', KEYS), 'dallas, tx')

section('display formatting')
eq('title-cases city and upper-cases state', titleCaseMarket('north palm beach, fl'), 'North Palm Beach, FL')
eq('single word city', titleCaseMarket('dallas, tx'), 'Dallas, TX')
eq('no state', titleCaseMarket('dallas'), 'Dallas')

section('key normalization')
eq('leading space stripped', normalizeMarketKey(' Boston, MA'), 'boston, ma')
eq('comma spacing normalized', normalizeMarketKey('Boston,MA'), 'boston, ma')
eq('inner whitespace collapsed', normalizeMarketKey('  North   Palm Beach ,  FL '), 'north palm beach, fl')

section('accepted-DMA matching (market size tier)')
const DMAS = [
  { dma_code: 'DMA-501', dma_name: 'New York, NY' },
  { dma_code: 'DMA-803', dma_name: 'Los Angeles, CA' },
  { dma_code: 'DMA-602', dma_name: 'Chicago, IL' },
  { dma_code: 'DMA-524', dma_name: 'Atlanta, GA' },
]
eq('exact city + state', matchAcceptedDma('Chicago, IL', DMAS)?.dma_code, 'DMA-602')
eq('city without a state still matches', matchAcceptedDma('Chicago', DMAS)?.dma_code, 'DMA-602')
eq('case and spacing ignored', matchAcceptedDma('  chicago ,il ', DMAS)?.dma_code, 'DMA-602')
// The substring test this replaces matched BOTH directions, so "York, PA"
// matched the New York DMA — tier 1 instead of tier 4, a 4.5x reach error.
eq('substring no longer matches a different city', matchAcceptedDma('York, PA', DMAS), undefined)
eq('wrong state rules out the DMA', matchAcceptedDma('Chicago, IN', DMAS), undefined)
eq('unknown market does not match', matchAcceptedDma('Allentown, PA', DMAS), undefined)

section('tier assignment')
eq('mega DMA', marketSizeTierFromDmaCode('DMA-501'), 1)
eq('major metro DMA', marketSizeTierFromDmaCode('DMA-602'), 2)
eq('other top-50 DMA', marketSizeTierFromDmaCode('DMA-999'), 3)
eq('non-DMA markets are tier 4, not tier 3', NON_DMA_MARKET_TIER, 4)
// Tier 4 is half of tier 3, so the old fallback doubled small-market reach.
const t3 = MARKET_SIZE_TIERS.find(t => t.id === 3)!.dailyA18
const t4 = MARKET_SIZE_TIERS.find(t => t.id === 4)!.dailyA18
eq('tier 3 is double tier 4', t3, t4 * 2)

section('notification recipient validation')
eq('single address', validateEmailList('andrew@lime-media.com'), null)
eq('several addresses', validateEmailList('a@lime-media.com, b@lime-media.com'), null)
eq('tolerates loose spacing', validateEmailList('  a@lime-media.com ,b@lime-media.com  '), null)
eq('empty is rejected', validateEmailList(''), 'At least one email address is required')
eq('commas only is rejected', validateEmailList(' , , '), 'At least one email address is required')
eq('names one bad address', validateEmailList('a@lime-media.com, nope'), 'Not a valid email address: nope')
eq('rejects a missing domain', validateEmailList('andrew@'), 'Not a valid email address: andrew@')
eq('rejects whitespace inside an address', validateEmailList('an drew@lime-media.com'), 'Not a valid email address: an drew@lime-media.com')

section('LED standard market for a hold (lib/standardMarkets.ts)')
{
  const box = (lat: number, lng: number, r = 0.3) => ({ ne_lat: lat + r, ne_lng: lng + r, sw_lat: lat - r, sw_lng: lng - r })
  const SM: StandardMarket[] = [
    { uid: 'DAL', key: 'dallas, tx', box: box(32.78, -96.8, 0.6) },
    { uid: 'FTW-AREA', key: 'arlington, tx', box: box(32.74, -97.1, 0.6) },
    { uid: 'PDX', key: 'portland, or', box: box(45.52, -122.68) },
    { uid: 'PWM', key: 'portland, me', box: box(43.66, -70.26) },
    { uid: 'NOBOX', key: 'ames, ia', box: null },
  ]
  const places: Record<string, { lat: number; lng: number }> = {
    'fort worth, tx': { lat: 32.75, lng: -97.33 },
    'plano, tx': { lat: 33.02, lng: -96.7 },
    'ames, ia': { lat: 42.03, lng: -93.62 },
    'tiny town, ks': { lat: 38.0, lng: -99.0 },
  }
  const locate = (m: string) => places[normalizeMarketKey(m)] ?? null
  eq('a standard market by name', pickStandardMarket('Dallas, TX', 'TX', SM, locate), { uid: 'DAL', via: 'name' })
  eq('name match ignores case and spacing', pickStandardMarket('  dallas ,tx', undefined, SM, locate)?.uid, 'DAL')
  eq('state picks between same-named markets', pickStandardMarket('Portland', 'ME', SM, locate)?.uid, 'PWM')
  eq('a town inside one market\'s area', pickStandardMarket('Plano, TX', 'TX', SM, locate), { uid: 'DAL', via: 'area' })
  // Fort Worth sits in both boxes; Arlington's centre is nearer.
  eq('overlapping areas: the nearest centre wins', pickStandardMarket('Fort Worth, TX', 'TX', SM, locate)?.uid, 'FTW-AREA')
  eq('a name match needs no area', pickStandardMarket('Ames, IA', 'IA', SM, locate)?.uid, 'NOBOX')
  eq('a town in no market\'s area is unset', pickStandardMarket('Tiny Town, KS', 'KS', SM, locate), null)
  eq('a multi-market label is unset', pickStandardMarket('Multi-market: Dallas, Portland', undefined, SM, locate), null)
  eq('blank is unset', pickStandardMarket('  ', undefined, SM, locate), null)
}
{
  const at = (lat: number, lng: number) => ({ ne_lat: lat + 0.2, ne_lng: lng + 0.2, sw_lat: lat - 0.2, sw_lng: lng - 0.2 })
  const city = (m: string) => ({ 'sherman, tx': { lat: 33.64, lng: -96.61 }, 'dallas, tx': { lat: 32.78, lng: -96.8 } } as Record<string, { lat: number; lng: number }>)[m] ?? null
  eq('an area on its own city is trusted', boxIsWhereItsCityIs({ uid: 'D', key: 'dallas, tx', box: at(32.78, -96.8) }, city), true)
  // Sherman, TX's row has a box in the panhandle, 350 miles away.
  eq('an area far from its city is not', boxIsWhereItsCityIs({ uid: 'S', key: 'sherman, tx', box: at(36.25, -101.89) }, city), false)
  eq('a city not in the place list is trusted', boxIsWhereItsCityIs({ uid: 'X', key: 'stanford / stamford, ct', box: at(41.05, -73.54) }, city), true)
}

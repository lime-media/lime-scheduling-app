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

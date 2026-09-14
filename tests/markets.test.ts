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

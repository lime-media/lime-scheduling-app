/**
 * Salesforce LED hold pushes — which ones the app mirrors.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { opportunityMarketCandidates, trucksToMirror } from '@/lib/sfdcIntegration'

const NOW = new Date('2026-10-02T12:00:00Z')
const later = new Date('2026-10-05T23:59:59Z'), earlier = new Date('2026-09-28T00:00:00Z')
const row = (truck_number: string, source: string, status: string, expires_at: Date | null) => ({ truck_number, source, status, expires_at })

section('Salesforce push: trucks the app holds right now are an echo; everything else is mirrored')
eq('created in Salesforce (nothing linked): mirror every truck', trucksToMirror(['9269'], [], NOW), ['9269'])
eq('created by a quote tool, holds live: nothing to mirror', trucksToMirror(['7423', '0820'], [row('7423', 'INTERNAL', 'HOLD', later), row('0820', 'INTERNAL', 'HOLD', later)], NOW), [])
eq('client portal hold, live: echo', trucksToMirror(['7423'], [row('7423', 'CLIENT', 'HOLD', later)], NOW), [])
eq('committed app booking (expiry irrelevant): echo', trucksToMirror(['7423'], [row('7423', 'INTERNAL', 'COMMITTED', earlier)], NOW), [])
eq('quote-only log made a booking in Salesforce (EXPIRED rows reserve nothing): mirror it',
  trucksToMirror(['7423'], [row('7423', 'INTERNAL', 'EXPIRED', NOW)], NOW), ['7423'])
eq('app hold past its expiry (sweep not run yet): mirror it', trucksToMirror(['7423'], [row('7423', 'INTERNAL', 'HOLD', earlier)], NOW), ['7423'])
eq('a rep adds a truck to an app quote in Salesforce: only the new truck is mirrored',
  trucksToMirror(['7423', '1106'], [row('7423', 'INTERNAL', 'HOLD', later)], NOW), ['1106'])
eq('trucks already mirrored from Salesforce are still updated', trucksToMirror(['9269'], [row('9269', 'SALESFORCE', 'HOLD', later)], NOW), ['9269'])

section('Salesforce push: the hold goes where the Opportunity says, never where the truck is parked')
{
  const c = opportunityMarketCandidates
  eq('a single market', c('Bakersfield', 'Bakersfield LED'), ['Bakersfield'])
  eq('a market with its state stays one market', c('San Francisco, CA', 'Atlassian - San Francisco LED'), ['San Francisco, CA'])
  eq('Las Vegas, NV', c('Las Vegas, NV', 'Atlassian - Las Vegas LED'), ['Las Vegas, NV'])
  eq('two markets', c('New York, San Francisco', 'Spellbook - New York/San Francisco LED'), ['New York City, NY', 'San Francisco'])
  eq('a semicolon list', c('San Francisco; New York; Miami', 'Deel - Multimarket LED'), ['San Francisco', 'New York City, NY', 'Miami'])
  eq('DC and LA are markets, not states; shorthand is spelled out', c('DC, NYC, LA', 'DC/NYC/LA LED'), ['Washington, DC', 'New York City, NY', 'Los Angeles, CA'])
  eq('blank field: the name says it', c(null, 'Detroit/LA/Austin/San Francisco/DC LED'), ['Detroit', 'Los Angeles, CA', 'Austin', 'San Francisco', 'Washington, DC'])
  eq('a placeholder field: the name says it', c('Market', 'Washington DC/Austin LED'), ['Washington, DC', 'Austin'])
  eq('notes mixed into the field are dropped', c('San Francisco, x1 and 3x Trucks options', 'San Francisco/x1 and 3x Trucks options LED'), ['San Francisco'])
  eq('the name with a client prefix', c(null, 'Mount Sinai - New York LED'), ['New York City, NY'])
  eq('a bare Washington is not guessed', c('Washington', 'Washington LED'), ['Washington'])
  eq('nothing usable anywhere', c(null, null), [])
  // Review: a two-letter state after a city is the city's state, never a second market.
  eq('Washington, DC is one market', c('Washington, DC', 'DC LED'), ['Washington, DC'])
  eq('New Orleans, LA is Louisiana, not Los Angeles', c('New Orleans, LA', 'New Orleans LED'), ['New Orleans, LA'])
  eq('Baton Rouge, LA', c('Baton Rouge, LA', null), ['Baton Rouge, LA'])
  eq('Shreveport, LA', c('Shreveport, LA', null), ['Shreveport, LA'])
  eq('two markets with states', c('Washington, DC, Austin, TX', null), ['Washington, DC', 'Austin, TX'])
  eq('LA after another shorthand is still Los Angeles', c('NYC, LA', null), ['New York City, NY', 'Los Angeles, CA'])
  eq('a lower-case state still counts', c('Dallas, tx', null), ['Dallas, TX'])
  eq('two letters that are no state stay a market', c('Austin, XX', null), ['Austin', 'XX'])
  // Review: the app's own names (PR 95) carry an account and dates, not markets.
  eq("an app-made name is never read as markets", c(null, 'Nike / Rolling Adz - Des Moines, IA - 2026-10-02 to 2026-10-03'), [])
  eq("nor an app multi-market name", c(null, 'Nike / Clear Trust Media - Multi-market (3 markets) - 2026-10-15 to 2026-11-19'), [])
  eq('dates in the field are dropped', c('Dallas, 2026-10-10', null), ['Dallas'])
}

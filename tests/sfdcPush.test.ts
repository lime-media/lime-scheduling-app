/**
 * Salesforce LED hold pushes — which ones the app mirrors.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { closedOpportunityBlocksReactivation, expiryClosesOpportunity, opportunityMarketCandidates, reactivationDecision, reconcileTarget, reopenQuestion, trucksToMirror } from '@/lib/sfdcIntegration'
import { opportunityRefusal, type BookingOpportunity } from '@/lib/sfdcBooking'

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

section('Salesforce: which expiries close the Opportunity')
{
  const h = (source: string, sfdc_hold_exp: Date | null, origination: string | null = null, sfdc_opportunity_id: string | null = '006VP00000gRDLxYAO') =>
    expiryClosesOpportunity({ source, sfdc_hold_exp, origination, sfdc_opportunity_id })
  const exp = new Date('2026-10-07T00:00:00Z')
  eq('a Salesforce push with a Hold Exp', h('SALESFORCE', exp), true)
  eq('a Salesforce push with no Hold Exp (72h fallback): the rep keeps the deal', h('SALESFORCE', null), false)
  eq('an internal quote hold', h('INTERNAL', null, 'frontend'), true)
  eq('a multi-market hold', h('INTERNAL', null, 'frontend'), true)
  eq('a client portal hold', h('CLIENT', null, 'client-view'), true)
  eq('a quote-only log never closes its Opportunity', h('INTERNAL', null, 'quote_only'), false)
  eq('no Opportunity, nothing to close', h('INTERNAL', null, 'frontend', null), false)
}

section('Salesforce: a hold is not revived under a Closed Lost Opportunity')
eq('Closed Lost: refused, and says to reopen in Salesforce', closedOpportunityBlocksReactivation({ isClosed: true, isWon: false, stageName: 'Closed Lost - Declined' })?.includes('Reopen the Opportunity in Salesforce'), true)
eq('open: allowed', closedOpportunityBlocksReactivation({ isClosed: false, isWon: false, stageName: 'WARM' }), null)
eq('Closed Won: allowed', closedOpportunityBlocksReactivation({ isClosed: true, isWon: true, stageName: 'Closed Won' }), null)
eq('stage unknown (Salesforce unreachable): allowed', closedOpportunityBlocksReactivation(null), null)

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

section('Salesforce: a hold added to an existing opportunity never closes it')
{
  const base = { source: 'INTERNAL', sfdc_hold_exp: null, origination: 'frontend', sfdc_opportunity_id: '006VP00000gRDLxYAO' }
  eq('an app booking on its own opportunity closes it', expiryClosesOpportunity({ ...base, features: JSON.stringify({ dailyRate: 1 }) }), true)
  eq('one added to a rep\'s existing deal does not', expiryClosesOpportunity({ ...base, features: JSON.stringify({ attachedToOpportunity: true }) }), false)
  eq('unreadable features: as before', expiryClosesOpportunity({ ...base, features: '{oops' }), true)
}

section('Closed Lost: staff may move the opportunity back to WARM')
{
  const lost = { isClosed: true, isWon: false, stageName: 'Closed Lost - Budget' }
  eq('Closed Lost, not yet asked: ask first', reactivationDecision(lost, false), { kind: 'reopenable', stageName: 'Closed Lost - Budget' })
  eq('Closed Lost, the person agreed: reopen', reactivationDecision(lost, true), { kind: 'reopen', stageName: 'Closed Lost - Budget' })
  eq('open: allowed, nothing to reopen', reactivationDecision({ isClosed: false, isWon: false, stageName: 'WARM' }, true), { kind: 'allowed' })
  eq('Closed Won is never reopened', reactivationDecision({ isClosed: true, isWon: true, stageName: 'Closed Won' }, true), { kind: 'allowed' })
  eq('an unknown stage never blocks', reactivationDecision(null, false), { kind: 'allowed' })
  eq('the question names the stage', reopenQuestion('Closed Lost - Budget'), 'This opportunity is "Closed Lost - Budget" in Salesforce. Move it back to Warm and continue?')

  const opp = (o: Partial<BookingOpportunity>) => ({ Id: '006X', AccountId: '001A', IsClosed: true, IsWon: false, StageName: 'Closed Lost - Declined', ...o }) as BookingOpportunity
  eq('opportunityRefusal: Closed Lost still refuses by default (quote tool, attach, client paths)', opportunityRefusal(opp({}), '001A')?.includes('Closed Lost - Declined'), true)
  eq('opportunityRefusal: a revision the person agreed to reopen passes', opportunityRefusal(opp({}), '001A', { closedLostReopening: true }), null)
  eq('opportunityRefusal: reopening never skips the account check', opportunityRefusal(opp({}), '001B', { closedLostReopening: true }), 'That opportunity belongs to a different Salesforce account.')
  // Closed Won is read-only (Andrew, 2026-10-20): no quote added to it, no revision of it.
  const won = opp({ IsWon: true, StageName: 'Closed Won' })
  eq('opportunityRefusal: Closed Won takes no added quote or revision', opportunityRefusal(won, '001A'), 'This deal is Closed Won in Salesforce; change it there first.')
  eq('opportunityRefusal: Closed Won refused even on a reopen request', opportunityRefusal(won, '001A', { closedLostReopening: true }), 'This deal is Closed Won in Salesforce; change it there first.')
  eq('opportunityRefusal: an open opportunity is fine', opportunityRefusal(opp({ IsClosed: false, StageName: 'WARM' }), '001A'), null)
}

section('reconcile: committed means Closed Won, in both directions (#120 review)')
{
  const won = { isClosed: true, isWon: true }, lost = { isClosed: true, isWon: false }, open = { isClosed: false, isWon: false }
  eq('won: a hold commits', reconcileTarget('HOLD', won), 'COMMITTED')
  eq('won: a waiting extension request commits', reconcileTarget('EXTENSION_REQUESTED', won), 'COMMITTED')
  eq('won: committed stays', reconcileTarget('COMMITTED', won), null)
  eq('lost: a hold is released', reconcileTarget('HOLD', lost), 'EXPIRED')
  eq('lost: a committed hold is released (the deal moved Won → Lost)', reconcileTarget('COMMITTED', lost), 'EXPIRED')
  eq('reopened: a committed hold goes back to HOLD, so it can be changed again', reconcileTarget('COMMITTED', open), 'HOLD')
  eq('open: an ordinary hold is left alone', reconcileTarget('HOLD', open), null)
  eq('open: a waiting extension request is left alone', reconcileTarget('EXTENSION_REQUESTED', open), null)
}

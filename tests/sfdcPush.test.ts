/**
 * Salesforce LED hold pushes — which ones the app mirrors.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { appHoldExpOf, closedOpportunityBlocksReactivation, expiryClosesOpportunity, opportunityMarketCandidates, pushedHoldExpiry, reactivationDecision, reconcileTarget, reopenQuestion, trucksToMirror, withAppHoldExp } from '@/lib/sfdcIntegration'
import { parseQuoteFeatures } from '@/lib/quoteFeatures'
import { ledFieldsDiffer, ledWindowFields, type LinkedHold } from '@/lib/opportunityMerge'
import { reinstatableHolds, reinstateRefusal } from '@/lib/bookings'
import { opportunityRefusal, type BookingOpportunity } from '@/lib/sfdcBooking'

const row = (truck_number: string, source: string, origination: string | null = 'frontend', status = 'HOLD') => ({ truck_number, source, origination, status })

section('Salesforce push: trucks the app hasn\'t released are its own')
eq('created in Salesforce (nothing linked): mirror every truck', trucksToMirror(['9269'], []), ['9269'])
eq('created by a quote tool: nothing to mirror', trucksToMirror(['7423', '0820'], [row('7423', 'INTERNAL'), row('0820', 'INTERNAL')]), [])
eq('client portal booking: echo', trucksToMirror(['7423'], [row('7423', 'CLIENT', null)]), [])
eq('a live app booking is the app\'s: not mirrored', trucksToMirror(['7423'], [row('7423', 'INTERNAL')]), [])
// #123 review: once the app's booking lapsed, a truck a rep lists is recorded
// (mirror paths record; clashes surface through /api/holds/infeasible), never
// dropped silently.
eq('a lapsed app booking: Salesforce is in charge again, mirror it', trucksToMirror(['7423'], [row('7423', 'INTERNAL', 'frontend', 'EXPIRED')]), ['7423'])
// Past its expiry but not yet swept: Salesforce still lists it until the sweep
// releases it and re-syncs, so mirroring now would re-reserve a truck the app
// is about to release.
eq('an app hold past expiry the sweep hasn\'t reached: still the app\'s', trucksToMirror(['7423'], [row('7423', 'INTERNAL', 'frontend', 'HOLD')]), [])
eq('quote-only log made a booking in Salesforce: mirror it', trucksToMirror(['7423'], [row('7423', 'INTERNAL', 'quote_only')]), ['7423'])
eq('a rep adds a truck to an app quote in Salesforce: only the new truck is mirrored', trucksToMirror(['7423', '1106'], [row('7423', 'INTERNAL')]), ['1106'])
eq('trucks already mirrored from Salesforce are still updated', trucksToMirror(['9269'], [row('9269', 'SALESFORCE', null)]), ['9269'])

section('the app\'s Hold Exp marker lives in features, never in sfdc_hold_exp')
{
  eq('recorded on a hold with no features', withAppHoldExp(null, '2026-10-23'), '{"appHoldExp":"2026-10-23"}')
  eq('other keys are kept', JSON.parse(withAppHoldExp('{"dailyRate":1200,"truckCount":2}', '2026-10-23')!), { dailyRate: 1200, truckCount: 2, appHoldExp: '2026-10-23' })
  eq('read back', appHoldExpOf('{"dailyRate":1200,"appHoldExp":"2026-10-23"}'), '2026-10-23')
  eq('removed: an object left empty goes back to null', withAppHoldExp('{"appHoldExp":"2026-10-23"}', null), null)
  eq('features that are not an object are left alone', withAppHoldExp('not json', '2026-10-23'), 'not json')
  eq('nothing recorded', appHoldExpOf(null), null)
  eq('a marker alone is not a quote breakdown', parseQuoteFeatures('{"appHoldExp":"2026-10-23"}'), null)
  eq('a real quote with the marker still is', parseQuoteFeatures('{"dailyRate":1200,"appHoldExp":"2026-10-23"}')?.dailyRate, 1200)
}

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

section('expiry changes: the LED fields the app writes to Salesforce (it owns them)')
{
  const today = '2026-10-20'
  const lh = (truck: string, expires: string | null, fromSalesforce = false): LinkedHold => ({ truck, market: 'Austin, TX', start: '2026-11-02', end: '2026-11-06', expires, fromSalesforce })
  eq('a reinstated booking: its trucks and its expiry date', ledWindowFields([lh('0382', '2026-10-23'), lh('7402', '2026-10-23')], today), { LED_Trucks__c: 'LED-0382;LED-7402', LED_Hold_Exp__c: '2026-10-23' })
  eq('several bookings on one opportunity: every held truck once, the earliest expiry still to come', ledWindowFields([lh('0382', '2026-10-30'), lh('7402', '2026-10-25'), lh('0382', '2026-10-30'), lh('LED-1894', '2026-11-02')], today), { LED_Trucks__c: 'LED-0382;LED-7402;LED-1894', LED_Hold_Exp__c: '2026-10-25' })
  eq('committed holds are listed but set no Hold Exp', ledWindowFields([lh('0382', null), lh('7402', '2026-10-28')], today), { LED_Trucks__c: 'LED-0382;LED-7402', LED_Hold_Exp__c: '2026-10-28' })
  eq('all committed: trucks only, no Hold Exp', ledWindowFields([lh('0382', null)], today), { LED_Trucks__c: 'LED-0382' })
  eq('a lapse date already past is not written', ledWindowFields([lh('0382', '2026-10-19'), lh('7402', '2026-10-24')], today), { LED_Trucks__c: 'LED-0382;LED-7402', LED_Hold_Exp__c: '2026-10-24' })
  eq('Salesforce-made holds: the app writes the Hold Exp too', ledWindowFields([lh('0382', '2026-10-27', true)], today), { LED_Trucks__c: 'LED-0382', LED_Hold_Exp__c: '2026-10-27' })
  eq('nothing reserves a truck any more (cancelled, denied): both cleared', ledWindowFields([], today), { LED_Trucks__c: null, LED_Hold_Exp__c: null })
}

section('Salesforce push: the echo of the app\'s own Hold Exp changes nothing')
{
  const current = new Date('2026-10-23T23:59:59Z'), fallback = new Date('2026-10-23T12:00:00Z')
  const recorded = '2026-10-23'
  eq('the date the app wrote comes back: the hold keeps its expiry', pushedHoldExpiry({ pushedHoldExp: '2026-10-23', appHoldExp: recorded, current, fallback }), { expiresAt: current, echo: true })
  const earlier = new Date('2026-10-22T18:00:00Z')
  eq('the echo never re-dates a hold (no shortening)', pushedHoldExpiry({ pushedHoldExp: '2026-10-23', appHoldExp: recorded, current: earlier, fallback }).expiresAt, earlier)
  const lapsed = new Date('2026-10-10T23:59:59Z')
  eq('the echo never revives a lapsed hold', pushedHoldExpiry({ pushedHoldExp: '2026-10-23', appHoldExp: recorded, current: lapsed, fallback }).expiresAt, lapsed)
  eq('a new Hold Exp from Salesforce wins, to the end of its day (Central)', pushedHoldExpiry({ pushedHoldExp: '2026-10-30', appHoldExp: recorded, current, fallback }), { expiresAt: new Date('2026-10-31T04:59:59.000Z'), echo: false })
  eq('nothing recorded yet: the pushed date applies', pushedHoldExpiry({ pushedHoldExp: '2026-10-23', appHoldExp: null, current, fallback }).echo, false)
  eq('no Hold Exp pushed: the hold keeps its expiry', pushedHoldExpiry({ pushedHoldExp: null, appHoldExp: recorded, current, fallback }).expiresAt, current)
  eq('no Hold Exp and nothing on the row: the fallback', pushedHoldExpiry({ pushedHoldExp: null, appHoldExp: null, current: null, fallback }).expiresAt, fallback)
}

section('reinstate: the whole booking or none of it')
{
  eq('no truck taken since it lapsed: reinstated', reinstateRefusal([]), null)
  const one = reinstateRefusal([{ truck: '7402', client: 'Bulldog', start: '2026-11-02', end: '2026-11-03' }])
  eq('one truck taken: refused, naming it', one?.includes('truck 7402 (Bulldog, 2026-11-02 to 2026-11-03)'), true)
  eq('and pointing at Revise', one?.includes('Revise the booking'), true)
  const two = reinstateRefusal([{ truck: '7402', client: 'Bulldog', start: '2026-11-02', end: '2026-11-03' }, { truck: '1894', client: 'McCoy', start: '2026-11-01', end: '2026-11-04' }])
  eq('several taken: every one named', !!two?.includes('7402') && !!two?.includes('1894') && two.startsWith("Can't reinstate: trucks have"), true)
}

section('reinstate: a market that already ended stays expired')
{
  const today = '2026-10-20'
  const h = (id: string, status: string, end: string) => ({ id, status, end_date: new Date(`${end}T00:00:00Z`) })
  const booking = [h('ended', 'EXPIRED', '2026-10-15'), h('today', 'EXPIRED', '2026-10-20'), h('ahead', 'EXPIRED', '2026-11-04'), h('live', 'HOLD', '2026-11-04')]
  eq('only lapsed markets still running come back', reinstatableHolds(booking, today).map(x => x.id), ['today', 'ahead'])
  eq('every lapsed market ended: nothing to reinstate', reinstatableHolds([h('ended', 'EXPIRED', '2026-10-15')], today), [])
}

section('webhook: an app-booked opportunity is the app\'s (#123 review)')
{
  const want = { LED_Trucks__c: 'LED-0382;LED-0912', LED_Hold_Exp__c: '2026-10-25' }
  eq('same trucks (any order, with or without LED-) and date: no difference', ledFieldsDiffer(want, ['0912', 'LED-0382'], '2026-10-25'), false)
  eq('a truck added in Salesforce: differs, so the app writes its own back', ledFieldsDiffer(want, ['0382', '0912', '0044'], '2026-10-25'), true)
  eq('a lapsed truck still listed in Salesforce: differs', ledFieldsDiffer({ LED_Trucks__c: 'LED-0382', LED_Hold_Exp__c: '2026-10-25' }, ['0382', '0912'], '2026-10-25'), true)
  eq('a different Hold Exp typed in Salesforce: differs', ledFieldsDiffer(want, ['0382', '0912'], '2026-11-30'), true)
  // Everything committed: the app writes no Hold Exp, so Salesforce's date is
  // never a difference (otherwise every push would re-sync, forever).
  eq('all committed: Salesforce\'s old date is not a difference', ledFieldsDiffer({ LED_Trucks__c: 'LED-0382' }, ['0382'], '2026-09-01'), false)
}

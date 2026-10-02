/**
 * Salesforce LED hold pushes — which ones the app mirrors.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { closedOpportunityBlocksReactivation, expiryClosesOpportunity, trucksToMirror } from '@/lib/sfdcIntegration'

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

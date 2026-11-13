/**
 * The opportunity name a seller can set on a new opportunity, and the
 * defaults the page shows (lib/opportunityName.ts).
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { opportunityName } from '@/lib/brand'
import { OPPORTUNITY_NAME_MAX, planOpportunityName, readOpportunityName, singleMarketOpportunityName } from '@/lib/opportunityName'

section('Opportunity name: defaults (the Closed Won form, Brand / Account / date)')
eq('single market: brand / account / first day', singleMarketOpportunityName('Nike', 'Rolling Adz', '2026-12-11'), 'Nike / Rolling Adz / 2026-12-11')
eq('single market: the shared builder', singleMarketOpportunityName('Nike', 'Rolling Adz', '2026-10-02'), opportunityName('Nike', 'Rolling Adz', '2026-10-02'))
eq('single market: no brand, no account', singleMarketOpportunityName('', undefined, '2026-12-01'), 'Client / 2026-12-01')
eq('plan: dated by the earliest delivery day, else the requested start',
  planOpportunityName('Nike', 'Acme', [
    { startDate: '2026-12-01', endDate: '2026-12-10', delivery: { firstDay: '2026-12-02', lastDay: '2026-12-09' } },
    { startDate: '2026-11-28', endDate: '2026-12-20', delivery: null },
  ]),
  'Nike / Acme / 2026-11-28')
eq('plan: a line not yet routed uses its requested start',
  planOpportunityName('', 'Acme', [{ startDate: '2026-12-01', endDate: '2026-12-10', delivery: { firstDay: null, lastDay: null } }]),
  'Acme / 2026-12-01')
eq('no date yet: just brand / account', opportunityName('Nike', 'Acme', ''), 'Nike / Acme')
eq('defaults never pass Salesforce\'s limit', singleMarketOpportunityName('B'.repeat(80), 'A'.repeat(80), '2026-01-01').length, OPPORTUNITY_NAME_MAX)

section('Opportunity name: what the seller typed')
eq('absent: the default', readOpportunityName(undefined), { name: null })
eq('null: the default', readOpportunityName(null), { name: null })
eq('blank: the default', readOpportunityName('   '), { name: null })
eq('spaces collapsed and trimmed', readOpportunityName('  Nike   Holiday  2026 '), { name: 'Nike Holiday 2026' })
eq('exactly 120 characters is fine', readOpportunityName('x'.repeat(120)), { name: 'x'.repeat(120) })
eq('over 120 is refused, not cut', 'error' in readOpportunityName('x'.repeat(121)), true)
eq('a number is refused', 'error' in readOpportunityName(42), true)
eq('an array is refused', 'error' in readOpportunityName(['Nike']), true)
eq('an object is refused', 'error' in readOpportunityName({ name: 'Nike' }), true)

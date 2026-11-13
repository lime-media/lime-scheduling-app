/**
 * The opportunity name a seller can set on a new opportunity, and the
 * defaults the page shows (lib/opportunityName.ts).
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { opportunityName } from '@/lib/brand'
import { OPPORTUNITY_NAME_MAX, multiMarketOpportunityName, planOpportunityName, readOpportunityName, singleMarketOpportunityName } from '@/lib/opportunityName'

section('Opportunity name: defaults')
eq('single market: the name the app always made', singleMarketOpportunityName('Nike', 'Rolling Adz', 'Des Moines, IA', '2026-10-02', '2026-10-03'),
  opportunityName('Nike', 'Rolling Adz', 'Des Moines, IA - 2026-10-02 to 2026-10-03'))
eq('single market: no account reads Client', singleMarketOpportunityName('', undefined, 'Austin, TX', '2026-12-01', '2026-12-05'), 'Client - Austin, TX - 2026-12-01 to 2026-12-05')
eq('multi-market: count and range', multiMarketOpportunityName('', 'Acme', 3, '2026-12-01', '2026-12-20'), 'Acme - Multi-market (3 markets) - 2026-12-01 to 2026-12-20')
eq('plan: delivery days win over the requested range, earliest to latest',
  planOpportunityName('Nike', 'Acme', [
    { startDate: '2026-12-01', endDate: '2026-12-10', delivery: { firstDay: '2026-12-02', lastDay: '2026-12-09' } },
    { startDate: '2026-11-28', endDate: '2026-12-20', delivery: null },
  ]),
  'Nike / Acme - Multi-market (2 markets) - 2026-11-28 to 2026-12-20')
eq('plan: a line not yet routed uses its requested dates',
  planOpportunityName('', 'Acme', [{ startDate: '2026-12-01', endDate: '2026-12-10', delivery: { firstDay: null, lastDay: null } }]),
  'Acme - Multi-market (1 markets) - 2026-12-01 to 2026-12-10')
eq('defaults never pass Salesforce\'s limit', singleMarketOpportunityName('B'.repeat(80), 'A'.repeat(80), 'X', '2026-01-01', '2026-01-02').length, OPPORTUNITY_NAME_MAX)

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

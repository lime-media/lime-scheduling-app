/**
 * Opportunity Type on app-made opportunities (lib/sfdcOpportunityType.ts).
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { NEED_OPPORTUNITY_TYPE, opportunityTypeOf, readOpportunityType, suggestedOpportunityType } from '@/lib/sfdcOpportunityType'

section('opportunityTypeOf')
eq('a picklist value', opportunityTypeOf('Existing Client'), 'Existing Client')
eq('case and spaces aside', opportunityTypeOf('  new   client '), 'New Client')
eq('off the picklist', opportunityTypeOf('Renewal'), null)

section('readOpportunityType')
eq('picked', readOpportunityType('External Referral', true), { opportunityType: 'External Referral' })
eq('none, when required (a seller on the quote pages)', readOpportunityType('', true), { error: NEED_OPPORTUNITY_TYPE })
eq('none, elsewhere: the suggestion is used', readOpportunityType(undefined, false), { opportunityType: null })
eq('off the picklist: refused, not dropped', 'error' in readOpportunityType('Renewal', false), true)

section('suggestedOpportunityType')
eq('an account that has won a deal', suggestedOpportunityType(true), 'Existing Client')
eq('one that hasn\'t', suggestedOpportunityType(false), 'New Client')
eq('not known (the account read failed): none, not a guess', suggestedOpportunityType(undefined), undefined)

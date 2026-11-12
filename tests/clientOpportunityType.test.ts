/**
 * Opportunity Type on client-made opportunities (lib/clientOpportunityType.ts).
 *
 * Run with: npm test
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { defer, eq, section } from './harness'
import { CLIENT_DEFAULT_OPPORTUNITY_TYPE, clientOpportunityType, latestLedTypeSoql } from '@/lib/clientOpportunityType'
import { SFDC_BOT_USER_IDS } from '@/lib/sfdcBots'

section('clientOpportunityType')
eq('the fallback is a picklist value', CLIENT_DEFAULT_OPPORTUNITY_TYPE, 'New Client')
defer((async () => {
  eq('the account\'s latest LED opportunity type', await clientOpportunityType('001A', async () => 'External Referral'), 'External Referral')
  eq('none on the account: New Client', await clientOpportunityType('001A', async () => null), 'New Client')
  const quiet = console.error
  console.error = () => {}
  try {
    eq('the lookup throws: New Client, never a refusal', await clientOpportunityType('001A', async () => { throw new Error('down') }), 'New Client')
  } finally {
    console.error = quiet
  }
})())

section('latestLedTypeSoql')
const soql = latestLedTypeSoql('001000000000001AAA')
eq('skips every bot user\'s opportunities', [...SFDC_BOT_USER_IDS].every(id => soql.includes(`CreatedById NOT IN (`) && soql.includes(`'${id}'`)), true)
eq('LED opportunities with a Type, newest first', /Job_Type__c = 'LED' AND Type != null.*ORDER BY CreatedDate DESC/.test(soql), true)

section('client booking paths set it')
for (const file of ['lib/clientBooking.ts', 'lib/clientMultiMarket.ts']) {
  const src = readFileSync(join(process.cwd(), file), 'utf8')
  eq(`${file} passes the client opportunity type`, src.includes('opportunityType: await clientOpportunityType('), true)
}

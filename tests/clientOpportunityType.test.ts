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
    eq('the lookup throws: no Type (a guess would be read back as the real one), never a refusal', await clientOpportunityType('001A', async () => { throw new Error('down') }), undefined)
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
  // Read with the account in one Promise.all, never awaited on its own just
  // before the create (a serial Salesforce round trip on every booking).
  const all = src.match(/await Promise\.all\(\[[\s\S]*?\]\)/g) ?? []
  eq(`${file} reads the type alongside the account`, all.some(a => a.includes('getSfdcAccountInfo(') && a.includes('clientOpportunityType(')), true)
  eq(`${file} never awaits the type lookup on its own`, src.includes('await clientOpportunityType('), false)
  eq(`${file} passes the type to the opportunity`, /opportunityType(: p\.opportunityType)?,/.test(src), true)
}

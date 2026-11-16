/**
 * Salesforce record links on staff pages (lib/sfdcLinks.ts). Run with: npm test
 */
import { eq, section } from './harness'
import { accountUrl, isSalesforceId, opportunityUrl, recordUrl } from '@/lib/sfdcLinks'

section('Salesforce links: a usable link, or none')
const base = 'https://example.my.salesforce.com'
eq('opportunity link, 18-character id', opportunityUrl(base, '006VP00000irDDtYAM'), 'https://example.my.salesforce.com/lightning/r/Opportunity/006VP00000irDDtYAM/view')
eq('account link, 15-character id, base with a trailing slash', accountUrl(base + '/', '001VP00000abcde'), 'https://example.my.salesforce.com/lightning/r/Account/001VP00000abcde/view')
eq('a path on the base is ignored', recordUrl(base + '/services/data', 'Opportunity', '006VP00000irDDtYAM'), 'https://example.my.salesforce.com/lightning/r/Opportunity/006VP00000irDDtYAM/view')
eq('empty id: no link', opportunityUrl(base, ''), null)
eq('null id: no link', opportunityUrl(base, null), null)
eq('id with markup: no link', opportunityUrl(base, '006VP0000"><x'), null)
eq('17 characters: no link', opportunityUrl(base, '006VP00000irDDtYA'), null)
eq('no base: no link', opportunityUrl(null, '006VP00000irDDtYAM'), null)
eq('http base: no link', opportunityUrl('http://example.my.salesforce.com', '006VP00000irDDtYAM'), null)
eq('unreadable base: no link', opportunityUrl('not a url', '006VP00000irDDtYAM'), null)
eq('a valid id is recognised', isSalesforceId('006VP00000irDDtYAM'), true)

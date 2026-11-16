/**
 * A revision reopens with the booking's account, primary contact and brand
 * even when it has no Salesforce opportunity (lib/bookingParty.ts).
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { PARTY_KEY, bookingParty, partyOf, reviseParty } from '@/lib/bookingParty'

const ACCOUNT = '001000000000001AAA'
const CONTACT = '003000000000001AAA'

const party = bookingParty({ accountId: ACCOUNT, accountName: 'Acme Corp', contactId: CONTACT, contactName: 'Pat Page', verified: { name: 'Pat Lee', email: 'pat@example.com', title: 'Buyer' }, brand: 'Widgets' })
const hold = (features: object | null, extra: Partial<{ client_name: string; sfdc_account_id: string | null }> = {}) => ({
  features: features ? JSON.stringify(features) : null,
  client_name: extra.client_name ?? 'Acme Corp',
  sfdc_account_id: extra.sfdc_account_id ?? null,
})

section('bookingParty: what a booking records')
eq("the contact's name as Salesforce has it wins over the page's", party.contact?.name, 'Pat Lee')
eq("Salesforce unreachable: the page's name is kept", bookingParty({ accountId: ACCOUNT, contactId: CONTACT, contactName: 'Pat Page', brand: '' }).contact?.name, 'Pat Page')
eq('no name anywhere: the contact is still kept, shown by id', bookingParty({ accountId: ACCOUNT, contactId: CONTACT, brand: '' }).contact?.name, CONTACT)
eq('no contact id: no contact', bookingParty({ accountId: ACCOUNT, contactId: '  ', brand: '' }).contact, null)
eq('a non-string account name is not recorded', bookingParty({ accountId: ACCOUNT, accountName: 7, brand: '' }).accountName, null)

section('partyOf: reading it back')
eq('round-trips through the features JSON', partyOf(JSON.stringify({ dailyRate: 1, [PARTY_KEY]: party })), party)
eq('older holds have none', partyOf(JSON.stringify({ dailyRate: 1 })), null)
eq('unreadable features: none', partyOf('not json'), null)
eq('no features: none', partyOf(null), null)
eq('a party without an account id is ignored', partyOf(JSON.stringify({ [PARTY_KEY]: { accountName: 'x' } })), null)

section('reviseParty: no opportunity, the booking recorded them')
{
  const r = reviseParty({ opp: null, holds: [hold({ [PARTY_KEY]: party })], clientType: 'Brand Direct' })
  eq('the account, priced as it was booked', r.account, { id: ACCOUNT, name: 'Acme Corp', clientType: 'Brand Direct' })
  eq('the primary contact', r.contact, { id: CONTACT, name: 'Pat Lee', email: 'pat@example.com', title: 'Buyer' })
  eq('the brand', r.brand, 'Widgets')
}
{
  const r = reviseParty({ opp: null, holds: [hold(null), hold({ [PARTY_KEY]: party })], clientType: null })
  eq('found on any hold of the booking', r.account?.id, ACCOUNT)
  eq('no recorded client type: left for the account search', 'clientType' in (r.account ?? {}), false)
}

section('reviseParty: older holds with neither')
eq("the account the reconcile copied onto the holds", reviseParty({ opp: null, holds: [hold({ dailyRate: 1 }, { sfdc_account_id: ACCOUNT, client_name: 'Acme Corp' })], clientType: null }), { account: { id: ACCOUNT, name: 'Acme Corp' }, contact: null, brand: '', leadSource: null, opportunityType: null })
eq('nothing recorded: asks for the account again', reviseParty({ opp: null, holds: [hold(null)], clientType: null }), { account: null, contact: null, brand: '', leadSource: null, opportunityType: null })

section('reviseParty: the opportunity wins where it has a value')
{
  const opp = { AccountId: '001000000000002AAA', Account: { Name: 'Acme Holdings' }, Primary_Contact__c: '003000000000002AAA', Primary_Contact__r: { Name: 'Sam Roe', Email: null, Title: null }, Brand_Job_Name__c: 'Gadgets' }
  const r = reviseParty({ opp, holds: [hold({ [PARTY_KEY]: party })], clientType: 'Brand Direct', oppClientType: 'Agency' })
  eq("the opportunity's account, with its own client type", r.account, { id: '001000000000002AAA', name: 'Acme Holdings', clientType: 'Agency' })
  eq("the opportunity's contact", r.contact?.id, '003000000000002AAA')
  eq("the opportunity's brand", r.brand, 'Gadgets')
}
{
  const opp = { AccountId: ACCOUNT, Account: null, Primary_Contact__c: null, Primary_Contact__r: null, Brand_Job_Name__c: null }
  const r = reviseParty({ opp, holds: [hold({ [PARTY_KEY]: party })], clientType: null, oppClientType: 'Agency' })
  eq('no account name on the opportunity: the recorded one', r.account?.name, 'Acme Corp')
  eq('no contact on the opportunity: the recorded one', r.contact?.id, CONTACT)
  eq('no brand on the opportunity: the recorded one', r.brand, 'Widgets')
}
{
  const opp = { AccountId: '001000000000009AAA', Primary_Contact__c: null, Primary_Contact__r: null, Brand_Job_Name__c: null }
  eq("the recorded contact is never paired with a different account", reviseParty({ opp, holds: [hold({ [PARTY_KEY]: party })], clientType: null }).contact, null)
}

section('lead source and opportunity type: a revision is not asked again')
{
  const picked = bookingParty({ accountId: ACCOUNT, brand: '', leadSource: 'External Referral', opportunityType: 'New Client' })
  const saved = JSON.stringify({ dailyRate: 1, [PARTY_KEY]: picked })
  eq('recorded with the party', [picked.leadSource, picked.opportunityType], ['External Referral', 'New Client'])
  eq('round-trips through the features JSON', partyOf(saved), picked)
  const back = reviseParty({ opp: null, holds: [hold(JSON.parse(saved))], clientType: null })
  eq('a booking with no opportunity reopens with them', [back.leadSource, back.opportunityType], ['External Referral', 'New Client'])
  const withOpp = reviseParty({ opp: { AccountId: ACCOUNT }, holds: [hold(JSON.parse(saved))], clientType: null })
  eq('with an opportunity too (sent back on save, so they carry forward)', [withOpp.leadSource, withOpp.opportunityType], ['External Referral', 'New Client'])
  eq('none picked: none recorded', 'leadSource' in bookingParty({ accountId: ACCOUNT, brand: '', leadSource: null, opportunityType: '  ' }), false)
  const older = reviseParty({ opp: null, holds: [hold({ [PARTY_KEY]: party })], clientType: null })
  eq('older holds: blank, asked as before', [older.leadSource, older.opportunityType], [null, null])
  const stale = partyOf(JSON.stringify({ [PARTY_KEY]: { accountId: ACCOUNT, brand: '', leadSource: 'Carrier Pigeon', opportunityType: 'Renewal' } }))
  eq('a value no longer on the picklist is not brought back (it would be refused on save)', [stale?.leadSource, stale?.opportunityType], [undefined, undefined])
}

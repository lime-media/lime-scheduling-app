/**
 * Who a booking is for: its Salesforce account, primary contact and brand, as
 * the rep booked it.
 *
 * Revising a booking used to read these only from its Salesforce opportunity,
 * so a booking whose opportunity wasn't created (Salesforce down or writes off,
 * every UAT booking) reopened blank and the rep typed them all again. Every
 * staff booking now records them on its holds' features (`party`), and a
 * revision reads the opportunity first (it may have been edited in Salesforce
 * since), then what was booked.
 */

import { PARTY_KEY } from '@/lib/quoteFeatures'
import { leadSourceOf } from '@/lib/sfdcLeadSource'
import { opportunityTypeOf } from '@/lib/sfdcOpportunityType'

export { PARTY_KEY }

export type PartyContact = { id: string; name: string; email?: string | null; title?: string | null }

/** As stored on each hold's features. `brand`: as saved, '' for no brand. */
export type BookingParty = {
  accountId: string
  accountName: string | null
  contact: PartyContact | null
  brand: string
  /**
   * The lead source and opportunity type the seller picked for a new
   * opportunity, so a revision that has to make one (the booking has none)
   * doesn't ask again. Absent on older holds and when none was picked.
   */
  leadSource?: string
  opportunityType?: string
}

/** A hold's features JSON as an object (empty when absent or unreadable). */
function featuresObject(json: string | null): Record<string, unknown> {
  if (!json) return {}
  try {
    const f: unknown = JSON.parse(json)
    return f && typeof f === 'object' ? f as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * The party to record on a booking's holds. The contact's name comes from
 * Salesforce when the booking checked it there (`verified`), else from what the
 * page sent; a contact with no name to show is still kept by id. Pure.
 */
export function bookingParty(input: {
  accountId: string
  accountName?: unknown
  contactId?: unknown
  contactName?: unknown
  verified?: { name: string; email?: string | null; title?: string | null } | null
  brand: string
  leadSource?: string | null
  opportunityType?: string | null
}): BookingParty {
  const contactId = str(input.contactId)
  const name = input.verified?.name ?? str(input.contactName)
  const leadSource = str(input.leadSource)
  const opportunityType = str(input.opportunityType)
  return {
    accountId: input.accountId,
    accountName: str(input.accountName),
    contact: contactId
      ? { id: contactId, name: name ?? contactId, email: input.verified?.email ?? null, title: input.verified?.title ?? null }
      : null,
    brand: input.brand,
    ...(leadSource ? { leadSource } : {}),
    ...(opportunityType ? { opportunityType } : {}),
  }
}

/** The party a hold's features recorded, or null (older holds, or unreadable). Pure. */
export function partyOf(features: string | null): BookingParty | null {
  const p = featuresObject(features)[PARTY_KEY]
  if (!p || typeof p !== 'object') return null
  const r = p as Record<string, unknown>
  const accountId = str(r.accountId)
  if (!accountId) return null
  const c = r.contact && typeof r.contact === 'object' ? r.contact as Record<string, unknown> : null
  const contactId = c ? str(c.id) : null
  return {
    accountId,
    accountName: str(r.accountName),
    contact: contactId ? { id: contactId, name: str(c!.name) ?? contactId, email: str(c!.email), title: str(c!.title) } : null,
    brand: typeof r.brand === 'string' ? r.brand : '',
    // Only a value still on Salesforce's picklist: a stale one would be refused on save.
    ...(leadSourceOf(r.leadSource) ? { leadSource: leadSourceOf(r.leadSource)! } : {}),
    ...(opportunityTypeOf(r.opportunityType) ? { opportunityType: opportunityTypeOf(r.opportunityType)! } : {}),
  }
}

/** The booking's opportunity, as much of it as a revision shows. */
export type PartyOpportunity = {
  AccountId: string
  Account?: { Name?: string | null } | null
  Primary_Contact__c?: string | null
  Primary_Contact__r?: { Name: string; Email?: string | null; Title?: string | null } | null
  Brand_Job_Name__c?: string | null
}

/**
 * Account, contact and brand for the revise form. Field by field, the
 * opportunity wins when it has a value (it may have been edited in Salesforce
 * since); otherwise what the booking recorded; for older holds with neither,
 * the account the reconcile copied onto the holds (`sfdc_account_id`). Pure.
 */
export function reviseParty(input: {
  opp: PartyOpportunity | null
  holds: { features: string | null; client_name: string; sfdc_account_id?: string | null }[]
  /** The client type the booking was priced as (lib/bookings.ts reviseRows). */
  clientType: 'Agency' | 'Brand Direct' | null
  /** The account's own client type, from the opportunity's account. */
  oppClientType?: 'Agency' | 'Brand Direct'
}): {
  account: { id: string; name: string; clientType?: 'Agency' | 'Brand Direct' } | null
  contact: PartyContact | null
  brand: string
  /** As the booking recorded them (null when it didn't): only used when a new opportunity is made. */
  leadSource: string | null
  opportunityType: string | null
} {
  const { opp, holds } = input
  const stored = holds.map(h => partyOf(h.features)).find(p => p) ?? null
  const clientName = holds[0]?.client_name ?? ''
  const fromColumn = holds.find(h => h.sfdc_account_id)?.sfdc_account_id ?? null

  const account = opp
    ? { id: opp.AccountId, name: opp.Account?.Name ?? stored?.accountName ?? clientName, clientType: input.oppClientType }
    : stored
      ? { id: stored.accountId, name: stored.accountName ?? clientName, ...(input.clientType ? { clientType: input.clientType } : {}) }
      : fromColumn
        ? { id: fromColumn, name: clientName, ...(input.clientType ? { clientType: input.clientType } : {}) }
        : null

  const contact = opp?.Primary_Contact__c && opp.Primary_Contact__r
    ? { id: opp.Primary_Contact__c, name: opp.Primary_Contact__r.Name, email: opp.Primary_Contact__r.Email ?? null, title: opp.Primary_Contact__r.Title ?? null }
    // The recorded contact belongs to the recorded account: never pair it with another.
    : stored?.contact && (!account || account.id === stored.accountId) ? stored.contact : null

  const brand = opp?.Brand_Job_Name__c?.trim() || stored?.brand || ''
  return { account, contact, brand, leadSource: stored?.leadSource ?? null, opportunityType: stored?.opportunityType ?? null }
}

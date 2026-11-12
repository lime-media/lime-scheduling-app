/**
 * The Opportunity Type of an opportunity a client makes in the portal (single
 * market or multi-market), or a partner through MCP: no seller is there to
 * pick one (lib/sfdcOpportunityType.ts). Andrew, 2026-11-11: the account's
 * latest LED opportunity's Type, else New Client (the picklist's "new
 * business" value). A failed lookup never stops a booking: it falls back too.
 */

import { sfdcQuery } from '@/lib/salesforceClient'
import { opportunityTypeOf, type OpportunityType } from '@/lib/sfdcOpportunityType'

/** When the account has no LED opportunity with a Type, or it can't be read. */
export const CLIENT_DEFAULT_OPPORTUNITY_TYPE: OpportunityType = 'New Client'

/**
 * The Type of the account's latest LED opportunity that has one still on the
 * picklist, or null. Throws if Salesforce can't be read.
 */
export async function latestLedOpportunityType(accountId: string): Promise<OpportunityType | null> {
  if (!/^[A-Za-z0-9]{15,18}$/.test(accountId)) return null
  const rows = await sfdcQuery<{ Type: string | null }>(
    `SELECT Type FROM Opportunity WHERE AccountId = '${accountId}' AND Job_Type__c = 'LED' AND Type != null ORDER BY CreatedDate DESC LIMIT 5`,
  )
  for (const r of rows) {
    const t = opportunityTypeOf(r.Type)
    if (t) return t
  }
  return null
}

/** A client opportunity's Type: the latest LED one's, else New Client. Never throws. */
export async function clientOpportunityType(
  accountId: string,
  lookup: (accountId: string) => Promise<OpportunityType | null> = latestLedOpportunityType,
): Promise<OpportunityType> {
  try {
    return (await lookup(accountId)) ?? CLIENT_DEFAULT_OPPORTUNITY_TYPE
  } catch (err) {
    console.error('[sfdc] latest LED opportunity type lookup failed; using New Client:', err)
    return CLIENT_DEFAULT_OPPORTUNITY_TYPE
  }
}

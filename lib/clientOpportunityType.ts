/**
 * The Opportunity Type of an opportunity a client makes in the portal (single
 * market or multi-market), or a partner through MCP: no seller is there to
 * pick one (lib/sfdcOpportunityType.ts). Andrew, 2026-11-11: the account's
 * latest LED opportunity's Type, else New Client (the picklist's "new
 * business" value). A failed lookup never stops a booking: the opportunity
 * is made with no Type. Not New Client: that guess would be written as an LED
 * opportunity's Type and read back by the next lookup as the account's real
 * one. With none, `Type != null` skips it and the next booking reads the real
 * Type.
 */

import { sfdcQuery } from '@/lib/salesforceClient'
import { opportunityTypeOf, type OpportunityType } from '@/lib/sfdcOpportunityType'
import { SFDC_BOT_USER_IDS } from '@/lib/sfdcBots'

/** When the account has no LED opportunity (not the bot's) with a Type. */
export const CLIENT_DEFAULT_OPPORTUNITY_TYPE: OpportunityType = 'New Client'

/**
 * The query for an account's latest LED opportunities with a Type, leaving out
 * those the Salesforce bot user made (lib/sfdcBots.ts): never designed for.
 * accountId must already be checked. Pure.
 */
export function latestLedTypeSoql(accountId: string): string {
  const bots = [...SFDC_BOT_USER_IDS].map(id => `'${id}'`).join(',')
  return `SELECT Type FROM Opportunity WHERE AccountId = '${accountId}' AND Job_Type__c = 'LED' AND Type != null`
    + (bots ? ` AND CreatedById NOT IN (${bots})` : '')
    + ' ORDER BY CreatedDate DESC LIMIT 5'
}

/**
 * The Type of the account's latest LED opportunity (not the bot's) that has
 * one still on the picklist, or null. Throws if Salesforce can't be read.
 */
export async function latestLedOpportunityType(accountId: string): Promise<OpportunityType | null> {
  if (!/^[A-Za-z0-9]{15,18}$/.test(accountId)) return null
  const rows = await sfdcQuery<{ Type: string | null }>(latestLedTypeSoql(accountId))
  for (const r of rows) {
    const t = opportunityTypeOf(r.Type)
    if (t) return t
  }
  return null
}

/**
 * A client opportunity's Type: the latest LED one's, else New Client; none
 * (undefined) when the lookup fails. Never throws.
 */
export async function clientOpportunityType(
  accountId: string,
  lookup: (accountId: string) => Promise<OpportunityType | null> = latestLedOpportunityType,
): Promise<OpportunityType | undefined> {
  try {
    return (await lookup(accountId)) ?? CLIENT_DEFAULT_OPPORTUNITY_TYPE
  } catch (err) {
    console.error('[sfdc] latest LED opportunity type lookup failed; the opportunity is made with no Type:', err)
    return undefined
  }
}

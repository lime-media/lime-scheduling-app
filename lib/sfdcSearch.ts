/**
 * Salesforce account and contact search for staff: the quote page's pickers
 * (GET /api/sfdc/accounts, /api/sfdc/contacts) and the staff AI chat's
 * find_account / find_contacts tools. Throws if Salesforce can't be reached.
 */

import { soqlString, sfdcQuery } from '@/lib/salesforceClient'
import { clientTypeOf } from '@/lib/pricing/brandMarkup'
import { leadSourceOf } from '@/lib/sfdcLeadSource'
import { suggestedOpportunityType } from '@/lib/sfdcOpportunityType'

/**
 * Accounts whose name contains q (at least 2 characters), up to 20. With
 * `suggestType` (the quote pages, which show the Opportunity Type picker),
 * each carries its type suggestion, at the cost of one more query.
 */
export async function searchAccounts(q: string, opts: { suggestType?: boolean } = {}) {
  if (q.length < 2) return []
  // Typed % and _ are literal (an account name, not a pattern): the AI chat
  // passes its own text here, and "_" alone would match any account.
  const escaped = soqlString(q).replace(/[%_]/g, '\\$&')
  const records = await sfdcQuery<{ Id: string; Name: string; Client_Type2__c: string | null; Opportunities?: { records?: { LeadSource: string | null }[] } | null }>(
    `SELECT Id, Name, Client_Type2__c, (SELECT LeadSource FROM Opportunities WHERE Job_Type__c = 'LED' AND LeadSource != null ORDER BY CreatedDate DESC LIMIT 1)`
    + ` FROM Account WHERE Name LIKE '%${escaped}%' ORDER BY Name LIMIT 20`
  )
  // clientType: Account "Client Type" — Agency (also when blank) or Brand Direct.
  // leadSource: the suggestion for a new quote, from the account's latest LED
  // opportunity that has one, only when it's still on the picklist.
  // opportunityType: the suggestion for a new quote, Existing Client when the
  // account has won a deal (one more query for the page of accounts). Only a
  // suggestion: if that query fails, the search still answers and the seller picks.
  const won = opts.suggestType && records.length
    ? await sfdcQuery<{ AccountId: string }>(
        `SELECT AccountId FROM Opportunity WHERE IsWon = true AND AccountId IN (${records.map(r => `'${r.Id}'`).join(',')}) GROUP BY AccountId`,
      ).then(rows => new Set(rows.map(r => r.AccountId)), (err) => { console.error('[sfdc] won-deal lookup for account search failed:', err); return null })
    : null
  return records.map(r => ({
    id: r.Id, name: r.Name, clientType: clientTypeOf(r.Client_Type2__c),
    leadSource: leadSourceOf(r.Opportunities?.records?.[0]?.LeadSource) ?? undefined,
    opportunityType: won ? suggestedOpportunityType(won.has(r.Id)) : undefined,
  }))
}

export const isAccountId = (id: string) => /^001[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/.test(id)

/**
 * An account id an LED client link is made for, and the reconcile stores on
 * holds (lib/ledClients.ts): 18 characters, as SOQL returns
 * Opportunity.AccountId. A 15-character one (or another object's id) would
 * make a link no hold ever matches. Pure.
 */
export const isLinkableAccount = (id: string) => id.length === 18 && isAccountId(id)

/**
 * The account's contacts by name (some agencies have close to a hundred); with
 * q, those whose name or email contains it. Up to 50. accountId must pass isAccountId.
 */
export async function searchContacts(accountId: string, q: string) {
  // Typed % and _ are literal here (a contact search is for names), unlike
  // soqlString's default of leaving LIKE wildcards as typed.
  const term = soqlString(q).replace(/[%_]/g, '\\$&')
  const match = q
    ? ` AND (Name LIKE '%${term}%' OR Email LIKE '%${term}%')`
    : ''
  const rows = await sfdcQuery<{ Id: string; Name: string; Title: string | null; Email: string | null }>(
    `SELECT Id, Name, Title, Email FROM Contact WHERE AccountId = '${accountId}'${match} ORDER BY Name LIMIT 50`,
  )
  return rows.map(r => ({ id: r.Id, name: r.Name, title: r.Title, email: r.Email }))
}

/**
 * Salesforce account and contact search for staff: the quote page's pickers
 * (GET /api/sfdc/accounts, /api/sfdc/contacts) and the staff AI chat's
 * find_account / find_contacts tools. Throws if Salesforce can't be reached.
 */

import { soqlString, sfdcQuery } from '@/lib/salesforceClient'
import { clientTypeOf } from '@/lib/pricing/brandMarkup'

/** Accounts whose name contains q (at least 2 characters), up to 20. */
export async function searchAccounts(q: string) {
  if (q.length < 2) return []
  const escaped = soqlString(q)
  const records = await sfdcQuery<{ Id: string; Name: string; Client_Type2__c: string | null }>(
    `SELECT Id, Name, Client_Type2__c FROM Account WHERE Name LIKE '%${escaped}%' ORDER BY Name LIMIT 20`
  )
  // clientType: Account "Client Type" — Agency (also when blank) or Brand Direct.
  return records.map(r => ({ id: r.Id, name: r.Name, clientType: clientTypeOf(r.Client_Type2__c) }))
}

export const isAccountId = (id: string) => /^001[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/.test(id)

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

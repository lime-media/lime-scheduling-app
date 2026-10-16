/**
 * Salesforce for bookings that change: a quote added to an existing
 * opportunity, or a booking revised in the planner (lib/opportunityMerge.ts
 * says what the fields become).
 */

import { isSfdcConfigured, sfdcQuery, updateOpportunity } from '@/lib/salesforceClient'
import { closedOpportunityBlocksReactivation } from '@/lib/sfdcIntegration'
import { mergedOpportunityFields, type BookingLed, type OpportunityLed } from '@/lib/opportunityMerge'

const OPP_ID = /^006[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/
const ACCOUNT_ID = /^001[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/

export type BookingOpportunity = OpportunityLed & {
  Id: string
  Name: string
  AccountId: string
  Account: { Name: string; Client_Type2__c: string | null } | null
  StageName: string
  IsClosed: boolean
  IsWon: boolean
  Brand_Job_Name__c: string | null
  Primary_Contact__c: string | null
  Primary_Contact__r: { Name: string; Email: string | null; Title: string | null } | null
}

/** An opportunity with what a booking change needs, or null when there is none (or no Salesforce). Throws when Salesforce cannot be read. */
export async function getBookingOpportunity(id: string): Promise<BookingOpportunity | null> {
  if (!isSfdcConfigured() || !OPP_ID.test(id)) return null
  const rows = await sfdcQuery<BookingOpportunity>(
    `SELECT Id, Name, AccountId, Account.Name, Account.Client_Type2__c, StageName, IsClosed, IsWon, Amount, Markets__c, LED_Trucks__c,
       LED_Hold_Start__c, LED_Hold_Stop__c, LED_Hold_Exp__c, Description, Brand_Job_Name__c,
       Primary_Contact__c, Primary_Contact__r.Name, Primary_Contact__r.Email, Primary_Contact__r.Title
     FROM Opportunity WHERE Id = '${id}' LIMIT 1`,
  )
  return rows[0] ?? null
}

/**
 * Why a booking cannot go onto this opportunity, or null. It must be the
 * chosen account's, and not lost: a Closed Lost opportunity would release
 * the new holds again at the next sweep (closedOpportunityBlocksReactivation).
 */
export function opportunityRefusal(opp: BookingOpportunity | null, accountId: string): string | null {
  if (!opp) return 'That Salesforce opportunity could not be found.'
  if (opp.AccountId !== accountId) return 'That opportunity belongs to a different Salesforce account.'
  return closedOpportunityBlocksReactivation({ isClosed: opp.IsClosed, isWon: opp.IsWon, stageName: opp.StageName })
}

export type OpenOpportunity = { id: string; name: string; stage: string; amount: number | null; holdStart: string | null; holdStop: string | null; createdDate: string }

/** The account's open LED opportunities, newest first — what a quote can be added to. */
export async function listOpenLedOpportunities(accountId: string): Promise<OpenOpportunity[]> {
  if (!ACCOUNT_ID.test(accountId)) return []
  const rows = await sfdcQuery<{ Id: string; Name: string; StageName: string; Amount: number | null; LED_Hold_Start__c: string | null; LED_Hold_Stop__c: string | null; CreatedDate: string }>(
    `SELECT Id, Name, StageName, Amount, LED_Hold_Start__c, LED_Hold_Stop__c, CreatedDate FROM Opportunity
     WHERE AccountId = '${accountId}' AND IsClosed = false AND Job_Type__c = 'LED' ORDER BY CreatedDate DESC LIMIT 25`,
  )
  return rows.map(r => ({ id: r.Id, name: r.Name, stage: r.StageName, amount: r.Amount, holdStart: r.LED_Hold_Start__c, holdStop: r.LED_Hold_Stop__c, createdDate: r.CreatedDate }))
}

/**
 * Write a booking onto an existing opportunity: ADD a quote to it, or REPLACE
 * its booking with a revision. The primary contact is set when the
 * opportunity has none. True when Salesforce accepted it.
 */
export async function applyBookingToOpportunity(opts: {
  opp: BookingOpportunity
  mode: 'ADD' | 'REPLACE'
  booking: BookingLed
  by: string
  primaryContactId?: string
}): Promise<boolean> {
  const fields = mergedOpportunityFields(opts.mode, opts.opp, opts.booking, { date: new Date().toISOString().slice(0, 10), by: opts.by })
  if (opts.primaryContactId && !opts.opp.Primary_Contact__c) fields.Primary_Contact__c = opts.primaryContactId
  return updateOpportunity(opts.opp.Id, fields)
}

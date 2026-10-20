/**
 * Salesforce for bookings that change: a quote added to an existing
 * opportunity, or a booking revised in the planner (lib/opportunityMerge.ts
 * says what the fields become).
 */

import { isSfdcConfigured, sfdcQuery, updateOpportunity, updateOpportunityWithError } from '@/lib/salesforceClient'
import { getOpportunityStage } from '@/lib/sfdcOpportunityReconcile'
import { DEFAULT_STAGE } from '@/lib/sfdcStages'
import { closedOpportunityBlocksReactivation } from '@/lib/sfdcIntegration'
import { ledWindowFields, mergedOpportunityFields, type BookingLed, type OpportunityLed } from '@/lib/opportunityMerge'
import { loadOpportunityReservingHolds } from '@/lib/bookingLoad'
import { CLOSED_WON_READ_ONLY } from '@/lib/bookings'
import { prisma } from '@/lib/prisma'

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
  /** Has products (Salesforce CPQ quote lines): Amount is then Salesforce's, not ours to write. */
  HasOpportunityLineItem: boolean
  Brand_Job_Name__c: string | null
  Primary_Contact__c: string | null
  Primary_Contact__r: { Name: string; Email: string | null; Title: string | null } | null
}

/** An opportunity with what a booking change needs, or null when there is none (or no Salesforce). Throws when Salesforce cannot be read. */
export async function getBookingOpportunity(id: string): Promise<BookingOpportunity | null> {
  if (!isSfdcConfigured() || !OPP_ID.test(id)) return null
  const rows = await sfdcQuery<BookingOpportunity>(
    `SELECT Id, Name, AccountId, Account.Name, Account.Client_Type2__c, StageName, IsClosed, IsWon, HasOpportunityLineItem, Amount, Markets__c, LED_Trucks__c,
       LED_Hold_Start__c, LED_Hold_Stop__c, LED_Hold_Exp__c, Description, Brand_Job_Name__c,
       Primary_Contact__c, Primary_Contact__r.Name, Primary_Contact__r.Email, Primary_Contact__r.Title
     FROM Opportunity WHERE Id = '${id}' LIMIT 1`,
  )
  return rows[0] ?? null
}

/**
 * Why a booking cannot go onto this opportunity (attach) or replace its
 * booking (revise), or null. It must be the chosen account's, and open: a
 * Closed Won deal is read-only in the app (lib/bookings.ts closedWonRefusal),
 * and a Closed Lost one would release the new holds again at the next sweep
 * (closedOpportunityBlocksReactivation). The attach picker already lists open
 * opportunities only; this is the server's word on it.
 */
export function opportunityRefusal(opp: BookingOpportunity | null, accountId: string, opts: { closedLostReopening?: boolean } = {}): string | null {
  if (!opp) return 'That Salesforce opportunity could not be found.'
  if (opp.AccountId !== accountId) return 'That opportunity belongs to a different Salesforce account.'
  if (opp.IsClosed && opp.IsWon) return CLOSED_WON_READ_ONLY
  // Off by default. Only a staff revision the person agreed to reopen passes
  // it (app/api/plan/hold); attach, the quote tool and the revise loader don't.
  if (opts.closedLostReopening && opp.IsClosed && !opp.IsWon) return null
  return closedOpportunityBlocksReactivation({ isClosed: opp.IsClosed, isWon: opp.IsWon, stageName: opp.StageName })
}

/**
 * Move a Closed Lost opportunity back to WARM (a staff choice on reinstate or
 * revise: lib/sfdcIntegration.ts reactivationDecision), then read the stage
 * back: Salesforce automation can refuse or re-close it. Only StageName is
 * written, never CloseDate or the org's auto-close fields. On any failure the
 * caller changes nothing in the app and shows `error` (Salesforce's own words
 * where it gave them).
 */
export async function reopenClosedLostOpportunity(opportunityId: string): Promise<{ ok: true; fromStage: string; toStage: string } | { ok: false; error: string }> {
  const before = await getOpportunityStage(opportunityId)
  if (!before) return { ok: false, error: 'Salesforce could not be reached to read the opportunity. Nothing was changed.' }
  if (!before.isClosed) return { ok: true, fromStage: before.stageName, toStage: before.stageName }
  if (before.isWon) return { ok: false, error: 'The opportunity is Closed Won; it is not reopened from here.' }
  const write = await updateOpportunityWithError(opportunityId, { StageName: DEFAULT_STAGE }).catch(err => ({ ok: false as const, error: err instanceof Error ? err.message : 'Salesforce could not be reached' }))
  if (!write.ok) return { ok: false, error: `Salesforce refused to move the opportunity to Warm: ${write.error}. Nothing was changed.` }
  const after = await getOpportunityStage(opportunityId)
  if (!after) return { ok: false, error: 'The opportunity was moved to Warm, but Salesforce could not be read back to confirm it. Nothing else was changed; check it in Salesforce and try again.' }
  if (after.isClosed) return { ok: false, error: `Salesforce put the opportunity back to "${after.stageName}" (an automation or rule there). Nothing was changed here; reopen it in Salesforce.` }
  return { ok: true, fromStage: before.stageName, toStage: after.stageName }
}

export type OpenOpportunity = { id: string; name: string; stage: string; amount: number | null; holdStart: string | null; holdStop: string | null; createdDate: string; hasProducts: boolean }

/** The account's open LED opportunities, newest first — what a quote can be added to. */
export async function listOpenLedOpportunities(accountId: string): Promise<OpenOpportunity[]> {
  if (!ACCOUNT_ID.test(accountId)) return []
  const rows = await sfdcQuery<{ Id: string; Name: string; StageName: string; Amount: number | null; LED_Hold_Start__c: string | null; LED_Hold_Stop__c: string | null; CreatedDate: string; HasOpportunityLineItem: boolean }>(
    `SELECT Id, Name, StageName, Amount, LED_Hold_Start__c, LED_Hold_Stop__c, CreatedDate, HasOpportunityLineItem FROM Opportunity
     WHERE AccountId = '${accountId}' AND IsClosed = false AND Job_Type__c = 'LED' ORDER BY CreatedDate DESC LIMIT 25`,
  )
  return rows.map(r => ({ id: r.Id, name: r.Name, stage: r.StageName, amount: r.Amount, holdStart: r.LED_Hold_Start__c, holdStop: r.LED_Hold_Stop__c, createdDate: r.CreatedDate, hasProducts: r.HasOpportunityLineItem }))
}

/**
 * Write a booking onto an existing opportunity: ADD a quote to it, or REPLACE
 * its booking with a revision. Call it after the booking's holds are written:
 * the truck list and hold window come from every hold reserving a truck on
 * the opportunity then. The primary contact is set when the opportunity has
 * none. An opportunity with products (a Salesforce CPQ quote) computes its
 * own Amount and refuses a written one, which would fail the whole update:
 * the Amount is left to its quote and the rep is told (`amountLeft`).
 * `windowLeft`: Salesforce reserved some of its trucks, so its hold dates
 * were not changed (WINDOW_LEFT_NOTE). `ok`: Salesforce accepted it.
 */
export async function applyBookingToOpportunity(opts: {
  opp: BookingOpportunity
  mode: 'ADD' | 'REPLACE'
  booking: BookingLed
  by: string
  primaryContactId?: string
  /** REPLACE: the revised booking as it stood. */
  was?: { amount: number | null; markets: string[] }
}): Promise<{ ok: boolean; amountLeft: boolean; windowLeft: boolean }> {
  const linked = await loadOpportunityReservingHolds(opts.opp.Id)
  const { fields, windowLeft } = mergedOpportunityFields(opts.mode, opts.opp, opts.booking, { date: new Date().toISOString().slice(0, 10), by: opts.by }, linked, opts.was)
  if (opts.primaryContactId && !opts.opp.Primary_Contact__c) fields.Primary_Contact__c = opts.primaryContactId
  const amountLeft = opts.opp.HasOpportunityLineItem
  if (amountLeft) delete fields.Amount
  return { ok: await updateOpportunity(opts.opp.Id, fields), amountLeft, windowLeft }
}

/**
 * After an expiry change or release (reinstate, approve or deny extension,
 * Edit expiry, cancel), the
 * opportunity's LED Trucks and LED Hold Exp are set from the app's holds that
 * reserve trucks on it now (lib/opportunityMerge.ts ledWindowFields): the app
 * owns them, so Salesforce shows the date the app holds to, and its push can
 * neither keep a lapsed truck nor carry a lapsed date back.
 *
 * The Hold Exp is recorded as sfdc_hold_exp on the opportunity's
 * Salesforce-made holds BEFORE the write (the push can arrive before the call
 * returns), so the push that follows is taken as the echo of this write and
 * changes no expiry (lib/sfdcIntegration.ts pushedHoldExpiry).
 *
 * Best-effort, after the app's own change has committed: never throws.
 * Returns what to tell the rep when Salesforce wasn't updated, else null.
 */
export async function syncOpportunityLedWindow(opportunityId: string): Promise<string | null> {
  if (!isSfdcConfigured() || !OPP_ID.test(opportunityId)) return null
  let fields: Record<string, string | null> = {}
  try {
    fields = ledWindowFields(await loadOpportunityReservingHolds(opportunityId), new Date().toISOString().slice(0, 10))
    if (fields.LED_Hold_Exp__c) {
      await prisma.hold.updateMany({
        where: { sfdc_opportunity_id: opportunityId, source: 'SALESFORCE' },
        data:  { sfdc_hold_exp: new Date(fields.LED_Hold_Exp__c) },
      })
    }
    const r = await updateOpportunityWithError(opportunityId, fields)
    if (r.ok) return null
    return ledWindowWarning(fields, r.error)
  } catch (err) {
    console.error(`[sfdc] LED window sync failed for ${opportunityId}:`, err)
    return ledWindowWarning(fields, err instanceof Error ? err.message : String(err))
  }
}

function ledWindowWarning(fields: Record<string, string | null>, error: string): string {
  const set = fields.LED_Trucks__c === null
    ? 'LED Trucks and LED Hold Exp to blank'
    : [
        fields.LED_Hold_Exp__c ? `LED Hold Exp to ${fields.LED_Hold_Exp__c}` : null,
        fields.LED_Trucks__c ? `LED Trucks to ${fields.LED_Trucks__c}` : null,
      ].filter(Boolean).join(' and ')
  return `Saved here, but Salesforce wasn't updated (${error}).${set ? ` Set ${set} on the opportunity,` : ' Check the opportunity,'} or a later Salesforce update may expire this booking again.`
}

/** What the rep is told when Salesforce reserved trucks on the opportunity and its hold dates were left alone. */
export const WINDOW_LEFT_NOTE = 'some of its trucks were reserved in Salesforce, so its LED hold dates were left as they were; check them'

/** What the rep is told when an opportunity's Amount comes from its Salesforce quote. */
export const AMOUNT_LEFT_NOTE = 'its amount comes from its Salesforce quote and was not changed; update that quote'

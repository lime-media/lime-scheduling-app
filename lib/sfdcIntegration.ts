import { QUOTE_ONLY_ORIGINATION } from '@/lib/quoteOnly'
import { holdReservesNow } from '@/lib/holdFilters'

// Holds pushed in from Salesforce are attributed to this service user, and
// automated actions on those holds (e.g. auto-release once a real LED shift
// is scheduled) are logged under it too.
export const SFDC_SERVICE_USER_EMAIL = 'sfdc-integration@lime-media.com'

/**
 * Which pushed trucks to mirror as SALESFORCE holds. The quote tools (single,
 * multi-market, client portal) create Opportunities WITH the LED fields set
 * and hold the trucks themselves (source INTERNAL / CLIENT, linked by
 * sfdc_opportunity_id), so Salesforce's push of those is an echo: mirroring it
 * would double-book. Only trucks the app holds RIGHT NOW are skipped — a
 * quote-only log or an expired hold reserves nothing, so when a rep fills in
 * the LED fields to make it a real booking, it is mirrored like any other.
 */
export function trucksToMirror(
  pushedTrucks: string[],
  linkedHolds: { truck_number: string; source: string; status: string; expires_at: Date | null }[],
  now: Date = new Date(),
): string[] {
  const held = new Set(linkedHolds.filter(h => h.source !== 'SALESFORCE' && holdReservesNow(h, now)).map(h => h.truck_number))
  return pushedTrucks.filter(t => !held.has(t))
}

/**
 * Does this hold expiring close its Salesforce Opportunity (once it was the
 * Opportunity's last live hold)? Every hold linked to an Opportunity does —
 * those Salesforce pushed with a Hold Exp, and those the app created from a
 * quote, multi-market or the client portal — except:
 *   - a Salesforce push with no Hold Exp (the 72h fallback): a rep leaving an
 *     optional field blank must not lose their deal;
 *   - a quote-only log: it never reserved anything, and stays open by design.
 */
export function expiryClosesOpportunity(h: { sfdc_opportunity_id: string | null; source: string; sfdc_hold_exp: Date | null; origination: string | null }): boolean {
  if (!h.sfdc_opportunity_id) return false
  if (h.origination === QUOTE_ONLY_ORIGINATION) return false
  return h.source !== 'SALESFORCE' || h.sfdc_hold_exp !== null
}

/**
 * Can a hold be put back in play (reinstated, or given a new expiry)? Not
 * while its Opportunity is Closed Lost: the hourly reconcile would expire it
 * again within the hour, silently. Reopening the deal is a Salesforce
 * decision; the message says so. An unknown stage (null) never blocks.
 */
export function closedOpportunityBlocksReactivation(stage: { isClosed: boolean; isWon: boolean; stageName: string } | null): string | null {
  if (!stage || !stage.isClosed || stage.isWon) return null
  return `Its Salesforce Opportunity is "${stage.stageName}", so the hold would be released again within the hour. Reopen the Opportunity in Salesforce first, then try again.`
}

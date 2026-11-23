/**
 * The Salesforce Opportunity stage the app writes. Salesforce's active open
 * stages are S1–S5 (verified against the org, 2026-11-22: S1 5%, S2 10%,
 * S3 20%, S4 40%, S5 60%); COLD, WARM and "Hot / Estimate Sent" are inactive.
 * The stage follows what the app made, not a pick (Andrew, 2026-11-22):
 *
 * - a quote-only log (low conviction, no trucks reserved) starts at S1;
 * - a reservation (trucks held: staff, client portal, MCP, chat) starts at S3.
 *
 * Closed Won and the Closed Lost reasons are set in Salesforce, never here.
 */

export const QUOTE_ONLY_STAGE = 'S1'
export const RESERVATION_STAGE = 'S3'

/** The stage a new opportunity starts at. */
export function newOpportunityStage(quoteOnly: boolean): string {
  return quoteOnly ? QUOTE_ONLY_STAGE : RESERVATION_STAGE
}

/**
 * Open stages below a reservation: an opportunity at one of these that gets
 * trucks reserved on it (a quote-only log turned into a reservation, or a
 * booking added to it) moves up to S3. The retired COLD and WARM count as
 * below it too. Anything further along (S4, S5, and the retired Hot, 80%) is
 * left where the seller put it: the app never moves a deal down.
 */
const BELOW_RESERVATION = new Set(['s1', 's2', 'cold', 'warm'])

/** The stage to move an open opportunity to when trucks are reserved on it, or null to leave it. Pure. */
export function reservationStageRaise(current: string | null | undefined, reserves: boolean): string | null {
  if (!reserves) return null
  return BELOW_RESERVATION.has(String(current ?? '').trim().toLowerCase()) ? RESERVATION_STAGE : null
}

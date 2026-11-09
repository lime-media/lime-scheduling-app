/**
 * Salesforce users that are bots, not people.
 *
 * "Leah Miles" is a bot that creates and owns LED opportunities. Its
 * opportunities don't fit how the app books (one "Multi-market: city, city…"
 * label for every truck, no market per truck, no schedule), and it is to be
 * switched off once the app's own booking works well (Andrew, 2026-11-09).
 * So nothing new is built for its opportunities: they are left out of what
 * the app sends to LED (CampaignIQ requests, LED Readiness), rather than
 * handled. The reconcile records each opportunity's creator on its holds
 * (app_holds.sfdc_created_by_id). Pure.
 */

/**
 * A user id the reconcile stores as a hold's opportunity creator: 18
 * characters, as SOQL returns Opportunity.CreatedById, so it compares equal to
 * the ids below. Pure.
 */
export const isUserId = (id: string): boolean => /^005[A-Za-z0-9]{15}$/.test(id)

/** User ids (18-character) of bots that create opportunities. */
export const SFDC_BOT_USER_IDS: ReadonlySet<string> = new Set([
  '005VP00000MNXcvYAH', // Leah Miles
])

/** Whether a hold's opportunity was made by a bot. */
export const madeByBot = (h: { sfdc_created_by_id: string | null }): boolean =>
  !!h.sfdc_created_by_id && SFDC_BOT_USER_IDS.has(h.sfdc_created_by_id)

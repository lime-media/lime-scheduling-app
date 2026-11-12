/**
 * Salesforce users that are bots, not people.
 *
 * "Leah Miles" is a bot that creates and owns LED opportunities. Its
 * opportunities don't fit how the app books (one "Multi-market: city, city…"
 * label for every truck, no market per truck, no schedule), and it is to be
 * switched off once the app's own booking works well (Andrew, 2026-11-09).
 * So nothing is designed around its opportunities: they come in from
 * Salesforce and hold their trucks for the life of the opportunity like any
 * deal, but are left out of what the app sends to LED (CampaignIQ requests,
 * LED Readiness) unless they close won (Andrew, 2026-11-12;
 * lib/campaignRequests.ts leftOutOfLed). The reconcile records each opportunity's creator on its holds
 * (app_holds.sfdc_created_by_id), so it is null until the first sweep after a
 * hold is made, which opportunityCreator reports as 'unknown': a sender
 * waits on it rather than reading it as a person.
 * Pure.
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

/**
 * Who made a hold's opportunity: a bot, a person, or not known yet (the
 * reconcile hasn't filled it). Three answers, so a sender can't read "not
 * known" as "a person" and send a bot booking in the first sweep's window.
 * A hold with no opportunity is never a bot's, and the reconcile never fills
 * it, so it is 'person' rather than 'unknown' (which would wait forever).
 */
export function opportunityCreator(h: { sfdc_opportunity_id: string | null; sfdc_created_by_id: string | null }): 'bot' | 'person' | 'unknown' {
  if (!h.sfdc_opportunity_id) return 'person'
  if (!h.sfdc_created_by_id) return 'unknown'
  return SFDC_BOT_USER_IDS.has(h.sfdc_created_by_id) ? 'bot' : 'person'
}

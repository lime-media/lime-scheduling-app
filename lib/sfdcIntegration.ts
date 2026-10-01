// Holds pushed in from Salesforce are attributed to this service user, and
// automated actions on those holds (e.g. auto-release once a real LED shift
// is scheduled) are logged under it too.
export const SFDC_SERVICE_USER_EMAIL = 'sfdc-integration@lime-media.com'

/**
 * Should a Salesforce push for this Opportunity be ignored because the app
 * already owns it? The quote tools (single, multi-market, client portal)
 * create their Opportunities WITH the LED fields filled in and keep their own
 * holds (source INTERNAL / CLIENT) linked by sfdc_opportunity_id. Salesforce
 * pushes every Opportunity whose LED fields are set, so those come straight
 * back; mirroring them as SALESFORCE holds would double-book the same trucks.
 */
export function appOwnsOpportunity(linkedHoldSources: string[]): boolean {
  return linkedHoldSources.some(s => s !== 'SALESFORCE')
}

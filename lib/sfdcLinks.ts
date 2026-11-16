/**
 * Links to Salesforce records, for staff pages (never the client portal).
 *
 * The base is the org's instance URL from the Salesforce connection
 * (lib/salesforceClient.ts salesforceInstanceUrl), sent by the server, so no
 * org domain is written into client code. Lightning's record path works on
 * the instance domain (it redirects to the org's Lightning domain). Pure.
 */

/** A Salesforce record id: 15 or 18 letters and digits. */
export function isSalesforceId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(id)
}

/** The record's page, or null when the base or id isn't usable. */
export function recordUrl(base: string | null | undefined, object: 'Opportunity' | 'Account', id: unknown): string | null {
  if (!base || !isSalesforceId(id)) return null
  let origin: string
  try {
    const url = new URL(base)
    if (url.protocol !== 'https:') return null
    origin = url.origin
  } catch {
    return null
  }
  return `${origin}/lightning/r/${object}/${id}/view`
}

export const opportunityUrl = (base: string | null | undefined, id: unknown) => recordUrl(base, 'Opportunity', id)
export const accountUrl = (base: string | null | undefined, id: unknown) => recordUrl(base, 'Account', id)

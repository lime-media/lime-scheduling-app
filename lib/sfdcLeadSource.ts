/**
 * Lead sources a seller may pick when a quote creates an opportunity: the
 * Opportunity.LeadSource picklist's active values, exactly as Salesforce has
 * them (verified against the org 2026-11-02; "EMS ‘25" has a curly quote).
 * Sources seen on older opportunities but no longer on the picklist (Firefly,
 * AdQuick and others) aren't offered. When the picklist changes in
 * Salesforce, change this list to match.
 */

export const LEAD_SOURCES = [
  'BAMFAM',
  'Email (from client)',
  'External Referral',
  'Get In Touch Web Form',
  'Other',
  'Phone Call',
  'Trade Show',
  'Turtle Transit',
  'EMS ‘25',
  'Outgrow',
  'LinkedIn',
  'Inbound Phone Call',
  'Marketing',
] as const

export type LeadSource = (typeof LEAD_SOURCES)[number]

/** A picklist value, matched exactly (case and spaces aside), or null. Pure. */
export function leadSourceOf(value: unknown): LeadSource | null {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v) return null
  return LEAD_SOURCES.find(s => s.toLowerCase() === v) ?? null
}

/** Why a booking that makes a new opportunity is refused without a lead source. */
export const NEED_LEAD_SOURCE = 'Pick a lead source for the opportunity.'

/**
 * A request's lead source: the picklist value (or null for none), or why it's
 * refused. A value off the picklist is refused rather than dropped; none is
 * refused only when `required` (a seller making a new opportunity). Pure.
 */
export function readLeadSource(value: unknown, required: boolean): { leadSource: LeadSource | null } | { error: string } {
  const leadSource = leadSourceOf(value)
  if (value != null && value !== '' && !leadSource) return { error: `"${String(value)}" isn't a Salesforce lead source.` }
  if (required && !leadSource) return { error: NEED_LEAD_SOURCE }
  return { leadSource }
}

/** A client booking in the portal: the client came in through the website. */
export const CLIENT_PORTAL_LEAD_SOURCE: LeadSource = 'Get In Touch Web Form'
/** A booking a partner makes through MCP on a client's behalf. */
export const MCP_LEAD_SOURCE: LeadSource = 'External Referral'

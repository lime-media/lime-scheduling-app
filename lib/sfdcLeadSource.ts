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

/** A client booking in the portal: the client came in through the website. */
export const CLIENT_PORTAL_LEAD_SOURCE: LeadSource = 'Get In Touch Web Form'
/** A booking a partner makes through MCP on a client's behalf. */
export const MCP_LEAD_SOURCE: LeadSource = 'External Referral'

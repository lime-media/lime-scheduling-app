/**
 * Opportunity Type (the standard Opportunity.Type picklist) on every
 * opportunity the app creates. Its values, as the org has them (checked
 * 2026-11-09 against a year of opportunities): New Client, Existing Client,
 * External Referral, Internal Referral. Most app-made opportunities had none.
 *
 * The suggestion: Existing Client when the account already has a won
 * opportunity, else New Client. A seller on the Quote Builder or the
 * Multi-market Plan confirms or changes it; anything else that creates an
 * opportunity (the staff chat and MCP, the client portal, partner MCP) gets
 * the suggestion. When the picklist changes in Salesforce, change this list.
 */

export const OPPORTUNITY_TYPES = ['New Client', 'Existing Client', 'External Referral', 'Internal Referral'] as const

export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number]

/** A picklist value, matched exactly (case and spaces aside), or null. Pure. */
export function opportunityTypeOf(value: unknown): OpportunityType | null {
  const v = String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  return OPPORTUNITY_TYPES.find(t => t.toLowerCase() === v) ?? null
}

/** Why a seller's quote is refused without one. */
export const NEED_OPPORTUNITY_TYPE = 'Pick the opportunity type.'

/**
 * A request's Opportunity Type: the picklist value (null for none), or why
 * it's refused. A value off the picklist is refused rather than dropped; none
 * is refused only when `required` (a seller making a new opportunity on the
 * quote pages). Pure.
 */
export function readOpportunityType(value: unknown, required: boolean): { opportunityType: OpportunityType | null } | { error: string } {
  const t = opportunityTypeOf(value)
  if (!t && String(value ?? '').trim() !== '') return { error: `"${String(value)}" isn't a Salesforce opportunity type.` }
  if (required && !t) return { error: NEED_OPPORTUNITY_TYPE }
  return { opportunityType: t }
}

/** The suggestion for an account: Existing Client once it has won a deal. Pure. */
export const suggestedOpportunityType = (hasWon: boolean | null | undefined): OpportunityType =>
  hasWon ? 'Existing Client' : 'New Client'

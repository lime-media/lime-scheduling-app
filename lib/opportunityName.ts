/**
 * The Salesforce Opportunity name a staff booking creates, and the name a
 * seller may type instead (Quote Builder, Multi-market Plan). Sellers rename
 * opportunities to a standard form at Closed Won; letting them set the name
 * when the opportunity is made keeps their pipeline readable before then.
 *
 * The defaults follow the Closed Won form, "Brand / Account / date"
 * (lib/brand.ts opportunityName), dated by the flight's first day, and are
 * shared here so the page shows the same name the server would create.
 * Pure: safe on the client.
 */

import { opportunityName } from '@/lib/brand'

/** Salesforce's limit on Opportunity.Name. */
export const OPPORTUNITY_NAME_MAX = 120

/** Quote Builder and the staff chat: "Brand / Account / start". */
export function singleMarketOpportunityName(brand: string, account: string | null | undefined, start: string): string {
  return opportunityName(brand, account || 'Client', start)
}

/** A booked line's dates, as the Multi-market Plan names them (delivery days when routed). */
export type NamedLine = { startDate: string; endDate: string; delivery?: { firstDay: string | null; lastDay: string | null } | null }

/**
 * The Multi-market Plan's default name for the lines being booked, dated by
 * the first delivery day. The server names the
 * opportunity from the re-priced selection the same way. Pure.
 */
export function planOpportunityName(brand: string, account: string, lines: NamedLine[]): string {
  const starts = lines.map(l => l.delivery?.firstDay ?? l.startDate).sort()
  return opportunityName(brand, account, starts[0] ?? '')
}

/**
 * The name a seller typed, as it will be saved: spaces collapsed and trimmed.
 * Absent or blank → null (the generated name is used). Not text, or longer
 * than Salesforce allows → an error to show. Pure.
 */
export function readOpportunityName(raw: unknown): { name: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { name: null }
  if (typeof raw !== 'string') return { error: 'The opportunity name must be text.' }
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name) return { name: null }
  if (name.length > OPPORTUNITY_NAME_MAX) return { error: `The opportunity name can be at most ${OPPORTUNITY_NAME_MAX} characters (it has ${name.length}).` }
  return { name }
}

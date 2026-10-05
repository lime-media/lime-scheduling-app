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
 * while its Opportunity is Closed Lost: the reconcile (every 15 minutes) would
 * expire it again, silently. Reopening the deal is a Salesforce
 * decision; the message says so. An unknown stage (null) never blocks.
 */
export function closedOpportunityBlocksReactivation(stage: { isClosed: boolean; isWon: boolean; stageName: string } | null): string | null {
  if (!stage || !stage.isClosed || stage.isWon) return null
  return `Its Salesforce Opportunity is "${stage.stageName}", so the hold would be released again within 15 minutes. Reopen the Opportunity in Salesforce first, then try again.`
}

/**
 * The markets a Salesforce Opportunity says its trucks are going to, as
 * candidate strings to resolve. Markets__c is free text ("Bakersfield",
 * "San Francisco, CA", "New York, San Francisco", "Detroit; Austin"). When it
 * is blank or a placeholder, a rep-style name stands in ("Orlando LED",
 * "Detroit/LA/Austin LED") — only a name with "LED" in it: the app's own
 * names ("Nike / Rolling Adz - Des Moines, IA - 2026-10-02 to …") carry an
 * account and dates, not markets, and the app always fills Markets__c.
 *
 * A two-letter US state code after a city is that city's state ("Washington,
 * DC", "New Orleans, LA"), never a second market. Standing alone, or after
 * another shorthand ("DC, NYC, LA"), DC and LA are the markets they abbreviate.
 * Empty when nothing usable is said.
 */
export function opportunityMarketCandidates(marketsField: string | null | undefined, opportunityName: string | null | undefined): string[] {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim()
  const field = clean(marketsField ?? '')
  const name = opportunityName ?? ''
  // "Mount Sinai - New York LED / DOmedia / 2026-…" → "New York".
  const fromName = /\bLED\b/i.test(name) ? clean(name.replace(/\s*\bLED\b.*$/i, '').replace(/^[^-]+ - /, '')) : ''
  const usable = (s: string) => s.length > 1 && !/^(market|markets|tbd|n\/?a)$/i.test(s)
  const text = usable(field) ? field : usable(fromName) ? fromName : ''
  if (!text) return []
  const out: string[] = []
  // Pieces with the separator before each: only a comma can introduce a state
  // ("City, ST"); a slash, semicolon, "&" or "and" always starts a new market.
  const parts = text.split(/(;|\/|,|&|\band\b)/i)
  for (let i = 0; i < parts.length; i += 2) {
    const piece = clean(parts[i])
    const afterComma = parts[i - 1] === ','
    if (!piece) continue
    // Notes typed into the field ("x1 and 3x Trucks options") and dates are not markets.
    if (/\btrucks?\b|\boptions?\b|^\d|\bx\d|\d{4}-\d{2}/i.test(piece)) continue
    const prev = out[out.length - 1]
    const isState = /^[a-z]{2}$/i.test(piece) && US_STATES.has(piece.toUpperCase())
    if (isState && afterComma && prev && !prev.includes(',') && !(prev.toLowerCase() in MARKET_SHORTHAND)) {
      out[out.length - 1] = `${prev}, ${piece.toUpperCase()}`
    } else {
      out.push(piece)
    }
  }
  return [...new Set(out.map(m => MARKET_SHORTHAND[m.toLowerCase().replace(/[.]/g, '')] ?? m))]
}

const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '))

/**
 * Shorthand reps write in Salesforce, to the standard market it means. Only
 * unambiguous ones: a bare "Washington" (DC or PA?) is left for the resolver
 * to refuse rather than guessed.
 */
const MARKET_SHORTHAND: Record<string, string> = {
  'nyc': 'New York City, NY',
  'new york': 'New York City, NY',
  'new york, ny': 'New York City, NY',
  'new york city': 'New York City, NY',
  'manhattan': 'New York City, NY',
  'la': 'Los Angeles, CA',
  'dc': 'Washington, DC',
  'washington dc': 'Washington, DC',
  'washington, dc': 'Washington, DC',
  'sf': 'San Francisco, CA',
}

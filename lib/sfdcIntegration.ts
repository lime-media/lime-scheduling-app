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
 * The markets a Salesforce Opportunity says its trucks are going to, as
 * candidate strings to resolve. Markets__c is free text ("Bakersfield",
 * "San Francisco, CA", "New York, San Francisco", "Detroit; Austin"); when it
 * is blank or a placeholder, the Opportunity name stands in ("Orlando LED",
 * "Detroit/LA/Austin LED"). A ", ST" after a city is its state, not a second
 * market. Empty when neither says anything usable.
 */
export function opportunityMarketCandidates(marketsField: string | null | undefined, opportunityName: string | null | undefined): string[] {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim()
  const field = clean(marketsField ?? '')
  // The name, minus the " LED" product suffix and anything after it
  // ("Blacksmith Salt Lake City LED / Lux Media Ads / 2026-10-01").
  const fromName = clean((opportunityName ?? '').replace(/\s+LED\b.*$/i, '').replace(/^[^-]+ - /, ''))
  const usable = (s: string) => s.length > 1 && !/^(market|markets|tbd|n\/?a)$/i.test(s)
  const text = usable(field) ? field : usable(fromName) ? fromName : ''
  if (!text) return []
  const out: string[] = []
  for (const piece of text.split(/[;/]|,|&|\band\b/i).map(clean).filter(Boolean)) {
    // "x1 and 3x Trucks options" and the like are notes, not markets.
    if (/\btrucks?\b|\boptions?\b|^\d|\bx\d/i.test(piece)) continue
    if (/^[A-Z]{2}$/.test(piece) && out.length && !out[out.length - 1].includes(',') && piece !== 'DC' && piece !== 'LA') {
      out[out.length - 1] = `${out[out.length - 1]}, ${piece}`
    } else {
      out.push(piece)
    }
  }
  return [...new Set(out.map(m => MARKET_SHORTHAND[m.toLowerCase().replace(/[.]/g, '')] ?? m))]
}

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

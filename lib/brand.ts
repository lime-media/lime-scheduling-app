/**
 * The brand on a quote: what the sales team types, as it goes to Salesforce
 * (Opportunity.Brand_Job_Name__c, 50 characters) and into the Opportunity
 * name so the deal is searchable by brand.
 *
 * Brand only — the company or product paying for the campaign. Trailing
 * asset types ("LED", "Airstream", "Glass Truck"), months, years and job
 * descriptors ("Tour", "Extension") are dropped: "Molytical August LED" is
 * "Molytical". Only from the END, so a brand that merely contains such a word
 * ("Build-A-Bear", "Busch") is left alone. The page shows the saved value as
 * the rep types, so nothing changes silently.
 */

export const BRAND_MAX = 50

const TRAILING = new RegExp(
  '[\\s,/–—-]+(?:' + [
    // Lime Media asset types (Salesforce Asset_Type__c and common shorthand)
    'led(?:\\s+trucks?)?', 'airstreams?', 'glass\\s+(?:trucks?|step\\s+vans?|trailers?)', 'step\\s+vans?',
    'gullwing(?:\\s+(?:airstream|step\\s+van))?', 'containers?', 'citroen(?:\\s+van)?', 'school\\s+bus(?:es)?',
    'dd\\s+bus', 'vw\\s+bus', 'metro\\s+mite(?:\\s+van)?', 'lunchbox(?:\\s+trailer)?', 'trailers?', 'pods?',
    'transit\\s+vans?', 'vans?', 'bus(?:es)?', 'trucks?', 'bronco', 'tuk\\s+tuk', 'rv',
    // months
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
    'november', 'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sept?', 'oct', 'nov', 'dec',
    // years
    '(?:19|20)\\d\\d', "'\\d\\d",
    // job descriptors
    'reactivation', 'rebrand', 'extension', 'change\\s+order', 'tour', 'build', 'purchase', 'repair', 'refresh',
  ].join('|') + ')$',
  'i',
)

/** Trimmed, with trailing asset types, months, years and descriptors dropped. */
function stripBrand(raw: string | null | undefined): string {
  let s = (raw ?? '').replace(/\s+/g, ' ').trim()
  for (let prev = ''; prev !== s; ) {
    prev = s
    const cut = s.replace(TRAILING, '').trim()
    if (cut) s = cut // never strip a brand down to nothing ("LED" alone stays)
  }
  return s
}

/** The brand as saved: trimmed, trailing descriptors dropped, at most 50 characters. */
export function cleanBrand(raw: string | null | undefined): string {
  return stripBrand(raw).slice(0, BRAND_MAX).trim()
}

/** Why the saved brand differs from what was typed, so the page can say so. */
export function brandChange(raw: string | null | undefined): 'none' | 'stripped' | 'cut' {
  const typed = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (stripBrand(typed) !== typed) return 'stripped'
  return typed.length > BRAND_MAX ? 'cut' : 'none'
}

/**
 * The Opportunity name: brand first, so it is what a search finds.
 * "Nike / Rolling Adz - Des Moines, IA - 2026-10-02 to 2026-10-03".
 * Without a brand the name is as before. Salesforce allows 120 characters.
 */
export function opportunityName(brand: string, account: string, rest: string): string {
  const head = brand ? `${brand} / ${account}` : account
  return `${head} - ${rest}`.slice(0, 120)
}

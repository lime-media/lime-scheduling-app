/**
 * "Log quote only": a low-conviction quote that creates a priced Salesforce
 * opportunity but reserves nothing.
 *
 * The app still records what was quoted — one record per market, as quoted,
 * even for a market no truck could cover — listed under Quotes on
 * Reservations until its start date passes (listedQuotes), so a seller never
 * needs Salesforce to find it.
 * Never linked to the client portal. The rows are written ALREADY EXPIRED:
 *   - an EXPIRED row never blocks a truck (availability, conflicts, quoting,
 *     the grid and map all ignore it);
 *   - the expiry sweep and the Closed Won/Lost reconcile skip EXPIRED
 *     rows, so they never touch the opportunity.
 *
 * The opportunity leaves the LED truck and hold-date fields EMPTY. Salesforce
 * turns those fields into reservations (the hold webhook), so filling them
 * would book the trucks right back. The trucks and dates priced go in the
 * Description instead.
 */

export const QUOTE_ONLY_ORIGINATION = 'quote_only'
export const QUOTE_ONLY_STATUS = 'EXPIRED'
export const QUOTE_ONLY_NOTE = 'Quote only: logged to Salesforce, no reservation.'

/**
 * Multi-market quote-only logs use their own booking-id prefix, apart from
 * real bookings (mm_), so a real booking is never taken for an earlier
 * quote-only log of the same quote.
 */
export const QUOTE_ONLY_GROUP_PREFIX = 'mmq_'

/** The truck on a quote-only record for a market the fleet could not cover. */
export const QUOTE_ONLY_NO_TRUCK = 'UNASSIGNED'

/** A booking row as listedQuotes needs it. Dates are YYYY-MM-DD (or ISO); created_at ISO. */
export type QuoteListRow = {
  origination: string
  status: string
  sfdc_opportunity_id: string | null
  start_date: string
  created_at: string
}

/** The statuses that mean an opportunity's trucks are reserved: its quote is taken up. */
const RESERVED_STATUSES = new Set(['HOLD', 'COMMITTED', 'EXTENSION_REQUESTED'])

/**
 * The quote-only logs Reservations lists under Quotes, by booking key:
 * - one per opportunity, the latest logged (a later quote-only log of the
 *   same opportunity supersedes the earlier one; a quote with no opportunity
 *   stands alone);
 * - not once that opportunity has a reservation (the quote was taken up);
 * - not once the booking's first start date has passed.
 * `today` is YYYY-MM-DD (Central). Pure.
 */
export function listedQuotes<R extends QuoteListRow>(rows: readonly R[], keyOf: (r: R) => string, today: string): Set<string> {
  const reserved = new Set(rows
    .filter(r => r.origination !== QUOTE_ONLY_ORIGINATION && RESERVED_STATUSES.has(r.status) && r.sfdc_opportunity_id)
    .map(r => r.sfdc_opportunity_id!))
  const quotes = new Map<string, { start: string; created: string; opp: string | null }>()
  for (const r of rows) {
    if (r.origination !== QUOTE_ONLY_ORIGINATION) continue
    const key = keyOf(r)
    const start = r.start_date.slice(0, 10)
    const q = quotes.get(key)
    if (!q) quotes.set(key, { start, created: r.created_at, opp: r.sfdc_opportunity_id })
    else {
      if (start < q.start) q.start = start
      if (r.created_at > q.created) q.created = r.created_at
      q.opp ??= r.sfdc_opportunity_id
    }
  }
  // The latest quote per opportunity (ties: the larger key, so the pick is stable).
  const latest = new Map<string, string>()
  for (const [key, q] of quotes) {
    if (!q.opp) continue
    const best = latest.get(q.opp)
    const b = best ? quotes.get(best)! : null
    if (!b || q.created > b.created || (q.created === b.created && key > best!)) latest.set(q.opp, key)
  }
  const out = new Set<string>()
  for (const [key, q] of quotes) {
    if (q.start < today) continue
    if (q.opp && (reserved.has(q.opp) || latest.get(q.opp) !== key)) continue
    out.add(key)
  }
  return out
}

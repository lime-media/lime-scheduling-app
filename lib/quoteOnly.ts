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
 * How plan/hold records a booking for the transport and deal-value metrics
 * (lib/transportMetricsRecord.ts recordBooking).
 *
 * Reserving a quote opens it as a revision, but every hold it replaces is a
 * quote-only log: nothing was booked and no transport leg was ever written.
 * So it is the first real booking: BOOKED, keyed on the new booking, which
 * the ops transport KPIs (built from BOOKED legs) and its later swaps and
 * executions then join. Only a revision that replaces at least one real hold
 * is REVISED, carrying that booking's lineage. Replaced holds not found (a
 * retry) stay REVISED: the retry guard answers those before anything is
 * recorded.
 */
export function bookingEvent(reviseKey: string | null | undefined, replaced: { origination: string | null }[]): 'BOOKED' | 'REVISED' {
  if (!reviseKey) return 'BOOKED'
  return replaced.length > 0 && replaced.every(h => h.origination === QUOTE_ONLY_ORIGINATION) ? 'BOOKED' : 'REVISED'
}

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
  /**
   * When the newest hold of this row's opportunity was made, any status or
   * kind, loaded or not (the list API reads it). A quote made before it was
   * replaced: by a newer quote, or by the booking Reserve made of it.
   */
  opp_latest_at?: string | null
}

/** The statuses that mean an opportunity's trucks are reserved: its quote is taken up. */
const RESERVED_STATUSES = new Set(['HOLD', 'COMMITTED', 'EXTENSION_REQUESTED'])

/**
 * The quote-only logs Reservations lists under Quotes, by booking key:
 * - one per opportunity, the latest: anything made on the opportunity after
 *   it (a newer quote, the booking Reserve made of it, in any status since)
 *   replaces it (`opp_latest_at`), and of the quotes loaded the newest wins;
 *   a quote with no opportunity stands alone;
 * - not while that opportunity has a live reservation (the quote was taken up);
 * - not once the booking's first start date has passed.
 * `today` is YYYY-MM-DD (Central). Pure.
 */
export function listedQuotes<R extends QuoteListRow>(rows: readonly R[], keyOf: (r: R) => string, today: string): Set<string> {
  const reserved = new Set(rows
    .filter(r => r.origination !== QUOTE_ONLY_ORIGINATION && RESERVED_STATUSES.has(r.status) && r.sfdc_opportunity_id)
    .map(r => r.sfdc_opportunity_id!))
  // The newest anything on each opportunity: what the API read, else what's loaded.
  const newest = new Map<string, string>()
  for (const r of rows) {
    if (!r.sfdc_opportunity_id) continue
    for (const at of [r.created_at, r.opp_latest_at]) {
      if (at && at > (newest.get(r.sfdc_opportunity_id) ?? '')) newest.set(r.sfdc_opportunity_id, at)
    }
  }
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
    if (q.opp && (reserved.has(q.opp) || latest.get(q.opp) !== key || q.created < newest.get(q.opp)!)) continue
    out.add(key)
  }
  return out
}

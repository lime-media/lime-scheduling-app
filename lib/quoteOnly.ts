/**
 * "Log quote only": a low-conviction quote that creates a priced Salesforce
 * opportunity but reserves nothing.
 *
 * The app still records what was quoted — one record per market, as quoted,
 * even for a market no truck could cover — listed on the internal Holds page
 * for QUOTE_ONLY_LIST_DAYS; the durable record is the Salesforce opportunity.
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

/** How long quote-only records stay listed on the Holds page (by creation). */
export const QUOTE_ONLY_LIST_DAYS = 90

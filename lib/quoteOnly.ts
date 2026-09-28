/**
 * "Log quote only": a low-conviction quote that creates a priced Salesforce
 * opportunity but reserves nothing.
 *
 * The app still records what was quoted (so it shows on the Holds page with
 * its breakdown), but the rows are written ALREADY EXPIRED:
 *   - an EXPIRED row never blocks a truck (availability, conflicts, quoting,
 *     the grid and map all ignore it);
 *   - the hourly expiry sweep and the Closed Won/Lost reconcile skip EXPIRED
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

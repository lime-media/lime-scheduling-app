import { QUOTE_ONLY_ORIGINATION } from '@/lib/quoteOnly'
import { holdReservesNow } from '@/lib/holdFilters'
import { endOfDayUtc } from '@/lib/dateOnly'
import { APP_HOLD_EXP_KEY } from '@/lib/quoteFeatures'

// Holds pushed in from Salesforce are attributed to this service user, and
// automated actions on those holds (e.g. auto-release once a real LED shift
// is scheduled) are logged under it too.
export const SFDC_SERVICE_USER_EMAIL = 'sfdc-integration@lime-media.com'

/**
 * Which pushed trucks to mirror as SALESFORCE holds. The quote tools (single,
 * multi-market, client portal) create Opportunities WITH the LED fields set
 * and hold the trucks themselves (source INTERNAL / CLIENT, linked by
 * sfdc_opportunity_id), so Salesforce's push of those is an echo: mirroring it
 * would double-book. Only a truck the app holds NOW counts: while the app
 * holds trucks on an opportunity the webhook doesn't mirror at all (it's the
 * app's; app/api/integrations/salesforce/hold), so this runs only once the
 * app's booking has lapsed or been released and Salesforce is in charge again.
 * Then a truck a rep lists is recorded like any other (a mirror path records,
 * it doesn't refuse; a clash surfaces through /api/holds/infeasible), never
 * dropped silently. A quote-only log never reserved anything, so it never
 * counts. (Reinstate and revise reopen a Closed Lost deal only after their
 * holds are saved, so the push that fires sees them live.)
 */
export function trucksToMirror(
  pushedTrucks: string[],
  linkedHolds: { truck_number: string; source: string; origination: string | null; status: string; expires_at: Date | null }[],
  now: Date = new Date(),
): string[] {
  const booked = new Set(linkedHolds
    .filter(h => h.source !== 'SALESFORCE' && h.origination !== QUOTE_ONLY_ORIGINATION && holdReservesNow(h, now))
    .map(h => h.truck_number))
  return pushedTrucks.filter(t => !booked.has(t))
}

// The key in a hold's features JSON recording the LED Hold Exp the app last wrote to its opportunity.
export { APP_HOLD_EXP_KEY }

const featureObject = (features: string | null | undefined): Record<string, unknown> | null => {
  if (!features) return {}
  try {
    const f = JSON.parse(features)
    return f && typeof f === 'object' && !Array.isArray(f) ? f : null
  } catch {
    return null
  }
}

/** The LED Hold Exp (YYYY-MM-DD) the app last wrote, as recorded in a hold's features, else null. Pure. */
export function appHoldExpOf(features: string | null | undefined): string | null {
  const v = featureObject(features)?.[APP_HOLD_EXP_KEY]
  return typeof v === 'string' ? v : null
}

/**
 * A hold's features with the app's LED Hold Exp recorded (or removed, with
 * null), every other key kept. Features that aren't a JSON object are left as
 * they are: the marker is skipped rather than anything overwritten. An object
 * left empty goes back to null. Pure.
 */
export function withAppHoldExp(features: string | null, date: string | null): string | null {
  const f = featureObject(features)
  if (f === null) return features
  const next = { ...f }
  if (date) next[APP_HOLD_EXP_KEY] = date
  else delete next[APP_HOLD_EXP_KEY]
  return Object.keys(next).length ? JSON.stringify(next) : null
}

/**
 * Does this hold expiring close its Salesforce Opportunity (once it was the
 * Opportunity's last live hold)? Every hold linked to an Opportunity does —
 * those Salesforce pushed with a Hold Exp, and those the app created from a
 * quote, multi-market or the client portal — except:
 *   - a Salesforce push with no Hold Exp (the 72h fallback): a rep leaving an
 *     optional field blank must not lose their deal;
 *   - a quote-only log: it never reserved anything, and stays open by design;
 *   - a hold added to an opportunity that already existed (features
 *     `attachedToOpportunity`): the rep's deal isn't the app's to close.
 */
/** Whether a hold's features mark it as added to an existing opportunity. */
export function attachedToOpportunity(features: string | null | undefined): boolean {
  try { return !!features && JSON.parse(features).attachedToOpportunity === true } catch { return false }
}

export function expiryClosesOpportunity(h: { sfdc_opportunity_id: string | null; source: string; sfdc_hold_exp: Date | null; origination: string | null; features?: string | null }): boolean {
  if (!h.sfdc_opportunity_id) return false
  if (h.origination === QUOTE_ONLY_ORIGINATION) return false
  if (attachedToOpportunity(h.features)) return false
  return h.source !== 'SALESFORCE' || h.sfdc_hold_exp !== null
}

/**
 * Can a hold be put back in play (reinstated, or given a new expiry)? Not
 * while its Opportunity is Closed Lost: the reconcile (every 15 minutes) would
 * expire it again, silently. Reopening the deal is a Salesforce
 * decision; the message says so. An unknown stage (null) never blocks.
 */
/**
 * What the 15-minute reconcile does to a hold linked to an Opportunity, given
 * that Opportunity's stage, or null to leave it. Committed means Closed Won
 * in Salesforce, in both directions: a won deal commits its holds; a committed
 * hold whose deal is no longer won goes back to HOLD (reopened) or EXPIRED
 * (Closed Lost), so "change it in Salesforce first" (lib/bookings.ts
 * closedWonRefusal) always has a way back. No loop with the outward close:
 * committed holds count as active, so the app never closes their deal as lost.
 * Pure.
 */
export function reconcileTarget(status: string, stage: { isClosed: boolean; isWon: boolean }): 'COMMITTED' | 'HOLD' | 'EXPIRED' | null {
  if (stage.isClosed && stage.isWon) return status === 'COMMITTED' ? null : 'COMMITTED'
  if (stage.isClosed) return status === 'EXPIRED' ? null : 'EXPIRED'
  return status === 'COMMITTED' ? 'HOLD' : null
}

/**
 * A Salesforce-made hold's expiry after a push. The app owns LED Hold Exp:
 * after an expiry change it writes the opportunity's Hold Exp and records that
 * date in the hold's features (APP_HOLD_EXP_KEY; lib/sfdcBooking.ts
 * syncOpportunityLedWindow) — not in sfdc_hold_exp, which keeps meaning
 * "Salesforce sent a Hold Exp" and decides whether a lapse closes the deal
 * (expiryClosesOpportunity) — so a push carrying the date recorded there
 * is the echo of the app's own write and the hold keeps its expiry: no
 * re-derived date, no override, no revival of a lapsed hold. A different Hold
 * Exp from Salesforce wins (the last day it's valid, to its end); with none,
 * the hold keeps what it has, and only a row with nothing gets the fallback.
 * Pure.
 */
export function pushedHoldExpiry(o: {
  pushedHoldExp: string | null
  /** The Hold Exp the app last wrote, from the hold's features (appHoldExpOf). */
  appHoldExp: string | null
  current: Date | null
  fallback: Date
}): { expiresAt: Date; echo: boolean } {
  const pushed = o.pushedHoldExp?.slice(0, 10) ?? null
  if (pushed && o.current && o.appHoldExp === pushed) {
    return { expiresAt: o.current, echo: true }
  }
  return { expiresAt: (pushed ? endOfDayUtc(pushed) : null) ?? o.current ?? o.fallback, echo: false }
}

export function closedOpportunityBlocksReactivation(stage: { isClosed: boolean; isWon: boolean; stageName: string } | null): string | null {
  if (!stage || !stage.isClosed || stage.isWon) return null
  return `Its Salesforce Opportunity is "${stage.stageName}", so the hold would be released again within 15 minutes. Reopen the Opportunity in Salesforce first, then try again.`
}

/**
 * Reinstating or revising onto a Closed Lost opportunity: staff may move the
 * deal back to WARM instead of being sent to Salesforce. `allowed` — nothing
 * stands in the way (open, won, or the stage is unknown); `reopenable` — Closed
 * Lost, so ask the person first; `reopen` — Closed Lost and they said yes.
 * Closed Won is never reopened. Only staff paths pass `reopenOpportunity`
 * (Reservations reinstate, the planner's revise); the client portal and MCP
 * never do, so for them a lost deal still refuses.
 */
export function reactivationDecision(
  stage: { isClosed: boolean; isWon: boolean; stageName: string } | null,
  reopenOpportunity: boolean,
): { kind: 'allowed' } | { kind: 'reopenable' | 'reopen'; stageName: string } {
  if (!stage || !stage.isClosed || stage.isWon) return { kind: 'allowed' }
  return { kind: reopenOpportunity ? 'reopen' : 'reopenable', stageName: stage.stageName }
}

/** What the person is asked before a Closed Lost opportunity is moved back to WARM. */
export function reopenQuestion(stageName: string): string {
  return `This opportunity is "${stageName}" in Salesforce. Move it back to Warm and continue?`
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

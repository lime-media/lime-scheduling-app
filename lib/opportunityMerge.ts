/**
 * The LED fields of an opportunity a quote is added to, or a booking revised
 * on. Pure, so it can be tested; lib/sfdcBooking.ts reads and writes them.
 *
 * - ADD (a new quote joins an existing opportunity): the booking grows. Amount
 *   adds; markets and trucks are the union; the description gains an entry.
 * - REPLACE (a booking revised in the planner): only the revised booking's
 *   share changes. Its old amount comes off and the new one goes on; markets
 *   only it had are dropped; other bookings on the same opportunity keep
 *   theirs. The old description is kept below the revision note.
 *
 * The truck list and hold window come from the holds that reserve trucks on
 * the opportunity once this booking is written (`linked`), not from one
 * booking, because Salesforce's push mirrors every listed truck the app does
 * not hold over that one window (lib/sfdcIntegration.ts trucksToMirror). So:
 * no reserving hold left after a revision clears them, and when Salesforce
 * itself reserved any of the trucks, the window and Hold Exp are left as they
 * are (`windowLeft`) so its trucks aren't re-dated to the app's dates.
 */

import { fitNames } from '@/lib/planning/booking'

export type OpportunityLed = {
  Amount: number | null
  Markets__c: string | null
  LED_Trucks__c: string | null
  LED_Hold_Start__c: string | null
  LED_Hold_Stop__c: string | null
  LED_Hold_Exp__c: string | null
  Description: string | null
}

/** A hold that reserves a truck on the opportunity now, after this booking's write. Dates YYYY-MM-DD. */
export type LinkedHold = {
  truck: string
  market: string
  start: string
  end: string
  /** Null for a committed hold (no expiry). */
  expires: string | null
  /** Mirrored from Salesforce (source SALESFORCE), not booked in the app. */
  fromSalesforce: boolean
}

export type BookingLed = {
  amount: number
  markets: string[]
  trucks: string[]
  /** Absent for a quote-only log: no LED hold fields (Salesforce would turn them into reservations). */
  holdStart?: string
  holdStop?: string
  holdExp?: string
  description: string
}

const splitList = (s: string | null, sep: RegExp) => (s ?? '').split(sep).map(x => x.trim()).filter(Boolean)
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')

/** Salesforce's LED Trucks values ("LED-0044"). */
const ledTruck = (t: string) => (t.startsWith('LED-') ? t : `LED-${t}`)

/** The LED Trucks value for the holds that reserve trucks on an opportunity: each truck once. */
export const ledTruckList = (linked: LinkedHold[]) => [...new Set(linked.map(h => ledTruck(h.truck)))].join(';')

/** The LED Hold Exp for those holds: the earliest expiry still to come, or null when none lapses (all committed). */
export const earliestHoldExp = (linked: LinkedHold[], today: string) =>
  linked.map(h => h.expires).filter((e): e is string => !!e && e >= today).sort()[0] ?? null

/**
 * The LED fields an expiry change or release writes (reinstate, approve or
 * deny extension, Edit expiry, cancel; lib/sfdcBooking.ts
 * syncOpportunityLedWindow). The app owns them, so they come from its holds
 * that reserve trucks on the opportunity now:
 * - LED Trucks: only trucks held now, so Salesforce's push can't mirror a
 *   truck the app isn't holding (trucksToMirror) or keep a released one;
 * - LED Hold Exp: the earliest expiry still to come, left out when nothing
 *   on it lapses (all committed).
 * Both cleared when nothing reserves a truck on it any more. Pure.
 */
export function ledWindowFields(linked: LinkedHold[], today: string): Record<string, string | null> {
  if (linked.length === 0) return { LED_Trucks__c: null, LED_Hold_Exp__c: null }
  const exp = earliestHoldExp(linked, today)
  return { LED_Trucks__c: ledTruckList(linked), ...(exp ? { LED_Hold_Exp__c: exp } : {}) }
}

export function mergedOpportunityFields(
  mode: 'ADD' | 'REPLACE',
  existing: OpportunityLed,
  booking: BookingLed,
  note: { date: string; by: string },
  linked: LinkedHold[],
  /** REPLACE: the revised booking as it stood (amount null when unpriced). */
  was?: { amount: number | null; markets: string[] },
): { fields: Record<string, unknown>; windowLeft: boolean } {
  const today = note.date
  const led = ledFields(mode, existing, booking, linked, today)
  if (mode === 'REPLACE') {
    const summary = [
      existing.Amount != null ? `amount ${money(existing.Amount)}` : null,
      existing.Markets__c ? `markets ${existing.Markets__c}` : null,
      existing.LED_Hold_Start__c ? `${existing.LED_Hold_Start__c} to ${existing.LED_Hold_Stop__c ?? '?'}` : null,
    ].filter(Boolean).join('; ')
    // Other bookings' share of the amount stays; an unpriced old booking can't be taken off, so the new one stands alone.
    const others = existing.Amount != null && was?.amount != null ? Math.max(0, existing.Amount - was.amount) : 0
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
    const stillHeld = (m: string) => linked.some(h => same(h.market, m))
    const keptMarkets = splitList(existing.Markets__c, /;/).filter(m => !(was?.markets ?? []).some(w => same(w, m)) || stillHeld(m))
    const markets = [...keptMarkets, ...booking.markets.filter(m => !keptMarkets.some(k => same(k, m)))]
    const header = `Revised ${today} by ${note.by}.${summary ? ` Was: ${summary}.` : ''}`
    return {
      fields: {
        Amount: others + booking.amount,
        Markets__c: fitNames(markets, 255),
        ...led.fields,
        Description: `${header}\n\n${booking.description}${existing.Description ? `\n\nBefore this revision:\n${existing.Description}` : ''}`.slice(0, 32000),
      },
      windowLeft: led.windowLeft,
    }
  }
  const markets = [...new Set([...splitList(existing.Markets__c, /;/), ...booking.markets])]
  return {
    fields: {
      Amount: (existing.Amount ?? 0) + booking.amount,
      Markets__c: fitNames(markets, 255),
      ...led.fields,
      Description: `${existing.Description ? `${existing.Description}\n\n` : ''}Added ${today} by ${note.by} (${money(booking.amount)}):\n${booking.description}`.slice(0, 32000),
    },
    windowLeft: led.windowLeft,
  }
}

function ledFields(
  mode: 'ADD' | 'REPLACE',
  existing: OpportunityLed,
  booking: BookingLed,
  linked: LinkedHold[],
  today: string,
): { fields: Record<string, unknown>; windowLeft: boolean } {
  if (linked.length === 0) {
    // Nothing reserves a truck on it. A revision clears what the old booking
    // listed, or Salesforce's push would reserve those trucks again. A
    // quote-only addition leaves a rep's own entries alone.
    return mode === 'REPLACE'
      ? { fields: { LED_Trucks__c: null, LED_Hold_Start__c: null, LED_Hold_Stop__c: null, LED_Hold_Exp__c: null }, windowLeft: false }
      : { fields: {}, windowLeft: false }
  }
  // A quote-only addition reserves nothing: the opportunity's LED fields stay as they are.
  if (mode === 'ADD' && !booking.holdStart) return { fields: {}, windowLeft: false }
  // Only trucks something holds now, in both modes: a listed truck whose
  // hold lapsed would otherwise be mirrored again over the new window.
  const trucks = ledTruckList(linked)
  if (linked.some(h => h.fromSalesforce)) return { fields: { LED_Trucks__c: trucks }, windowLeft: true }
  const exp = earliestHoldExp(linked, today)
  return {
    fields: {
      LED_Trucks__c: trucks,
      LED_Hold_Start__c: linked.map(h => h.start).sort()[0],
      LED_Hold_Stop__c: linked.map(h => h.end).sort().reverse()[0],
      ...(exp ? { LED_Hold_Exp__c: exp } : {}),
    },
    windowLeft: false,
  }
}

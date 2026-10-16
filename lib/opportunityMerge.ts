/**
 * The LED fields of an opportunity a quote is added to, or a booking revised
 * on. Pure, so it can be tested; lib/sfdcBooking.ts reads and writes them.
 *
 * - ADD (a new quote joins an existing opportunity): the booking grows. Amount
 *   adds; markets and trucks are the union; the hold window widens; the hold
 *   expiry is the earliest still to come.
 * - REPLACE (a booking revised in the planner): the opportunity describes the
 *   booking as it now stands. The previous figures go to the description's
 *   revision note, so the history is not lost.
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
const minDate = (a: string | null | undefined, b: string | null | undefined) => (!a ? b ?? null : !b ? a : a < b ? a : b)
const maxDate = (a: string | null | undefined, b: string | null | undefined) => (!a ? b ?? null : !b ? a : a > b ? a : b)
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')

/** Salesforce's LED Trucks values ("LED-0044"). */
const ledTruck = (t: string) => (t.startsWith('LED-') ? t : `LED-${t}`)

export function mergedOpportunityFields(
  mode: 'ADD' | 'REPLACE',
  existing: OpportunityLed,
  booking: BookingLed,
  note: { date: string; by: string },
): Record<string, unknown> {
  if (mode === 'REPLACE') {
    const was = [
      existing.Amount != null ? `amount ${money(existing.Amount)}` : null,
      existing.Markets__c ? `markets ${existing.Markets__c}` : null,
      existing.LED_Hold_Start__c ? `${existing.LED_Hold_Start__c} to ${existing.LED_Hold_Stop__c ?? '?'}` : null,
    ].filter(Boolean).join('; ')
    return {
      Amount: booking.amount,
      Markets__c: fitNames(booking.markets, 255),
      ...(booking.holdStart ? {
        LED_Trucks__c: booking.trucks.map(ledTruck).join(';'),
        LED_Hold_Start__c: booking.holdStart,
        LED_Hold_Stop__c: booking.holdStop,
        LED_Hold_Exp__c: booking.holdExp,
      } : {}),
      Description: `Revised ${note.date} by ${note.by}.${was ? ` Was: ${was}.` : ''}\n\n${booking.description}`.slice(0, 32000),
    }
  }
  const trucks = [...new Set([...splitList(existing.LED_Trucks__c, /;/), ...booking.trucks.map(ledTruck)])]
  const markets = [...new Set([...splitList(existing.Markets__c, /;/), ...booking.markets])]
  const today = note.date
  const futureExp = existing.LED_Hold_Exp__c && existing.LED_Hold_Exp__c >= today ? existing.LED_Hold_Exp__c : null
  return {
    Amount: (existing.Amount ?? 0) + booking.amount,
    Markets__c: fitNames(markets, 255),
    ...(booking.holdStart ? {
      LED_Trucks__c: trucks.join(';'),
      LED_Hold_Start__c: minDate(existing.LED_Hold_Start__c, booking.holdStart),
      LED_Hold_Stop__c: maxDate(existing.LED_Hold_Stop__c, booking.holdStop),
      LED_Hold_Exp__c: minDate(futureExp, booking.holdExp),
    } : {}),
    Description: `${existing.Description ? `${existing.Description}\n\n` : ''}Added ${note.date} by ${note.by} (${money(booking.amount)}):\n${booking.description}`.slice(0, 32000),
  }
}

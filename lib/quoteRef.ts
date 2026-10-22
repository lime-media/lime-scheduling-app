/**
 * The quote ref the staff AI chat shows with a bookable quote
 * (lib/staffChatTools.ts): an HMAC of everything that sets the price or what's
 * booked, and the total. place_hold books only a ref the rep was shown, with
 * the same inputs, terms and total. Defaults are filled the way staffQuote and
 * staffBooking fill them,
 * so leaving a field out and passing its default give the same ref. Pure.
 */

import { createHmac } from 'crypto'
import { VALID_STUDIES } from '@/lib/pricing/config'
import type { StaffQuoteInput } from '@/lib/staffQuote'
import { DEFAULT_HOLD_DAYS } from '@/lib/holdExpiry'
import { openStage } from '@/lib/sfdcStages'

/**
 * What a booking writes beyond the price: the hold's client and the
 * opportunity's contact, brand and stage, and how long the trucks are held.
 * The rep confirms these with the quote, so the ref covers them too.
 */
export type BookingTerms = { sfdc_account_name?: string; primary_contact_id?: string; brand?: string; hold_days?: number; stage?: string }

export function quoteRef(q: StaffQuoteInput, total: number, terms: BookingTerms = {}, secret = process.env.NEXTAUTH_SECRET ?? 'quote-ref'): string {
  const studies = (q.studies ?? []).map(s => s.trim().toLowerCase()).filter(s => (VALID_STUDIES as readonly string[]).includes(s)).sort()
  const payload = JSON.stringify([
    q.market, q.start_date, q.end_date, q.truck_count,
    q.shadow_fencing !== false, q.smart_directional ?? false, q.device_id ?? false, studies,
    q.days_per_week ?? null, q.operating_hours ?? 8, q.sfdc_account_id ?? null, q.brand_markup_pct ?? null,
    Math.round(total * 100),
    terms.sfdc_account_name?.trim() || null, terms.primary_contact_id?.trim() || null, terms.brand?.trim() || null,
    terms.hold_days ?? DEFAULT_HOLD_DAYS, openStage(terms.stage),
  ])
  return `Q-${createHmac('sha256', secret).update(payload).digest('hex').slice(0, 8).toUpperCase()}`
}

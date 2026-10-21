/**
 * The quote ref the staff AI chat shows with a bookable quote
 * (lib/staffChatTools.ts): an HMAC of everything that sets the price or what's
 * booked, and the total. place_hold books only a ref the rep was shown, with
 * the same inputs and total. Defaults are filled the way staffQuote fills them,
 * so leaving a field out and passing its default give the same ref. Pure.
 */

import { createHmac } from 'crypto'
import { VALID_STUDIES } from '@/lib/pricing/config'
import type { StaffQuoteInput } from '@/lib/staffQuote'

export function quoteRef(q: StaffQuoteInput, total: number, secret = process.env.NEXTAUTH_SECRET ?? 'quote-ref'): string {
  const studies = (q.studies ?? []).map(s => s.trim().toLowerCase()).filter(s => (VALID_STUDIES as readonly string[]).includes(s)).sort()
  const payload = JSON.stringify([
    q.market, q.start_date, q.end_date, q.truck_count,
    q.shadow_fencing !== false, q.smart_directional ?? false, q.device_id ?? false, studies,
    q.days_per_week ?? null, q.operating_hours ?? 8, q.sfdc_account_id ?? null, q.brand_markup_pct ?? null,
    Math.round(total * 100),
  ])
  return `Q-${createHmac('sha256', secret).update(payload).digest('hex').slice(0, 8).toUpperCase()}`
}

/**
 * The live bookings as LED campaign requests (lib/campaignRequests.ts), read
 * once for Ops → LED Readiness and for sending a booking to LED
 * (lib/coreSend.ts), so the page and the send agree on what is Ready.
 *
 * Bookings whose dates have all passed, and quote-only logs, are left out; a
 * booking still running is built whole, its finished markets included.
 */

import { prisma } from '@/lib/prisma'
import { centralDate } from '@/lib/dateOnly'
import { QUOTE_ONLY_ORIGINATION } from '@/lib/quoteOnly'
import { buildRequests, type BookingRequest, type RequestHold } from '@/lib/campaignRequests'
import { bookingKey } from '@/lib/bookings'
import { opportunityCreator } from '@/lib/sfdcBots'

/** What the app knows of a booking's request in Core (app_campaign_requests). */
export type SentRow = { booking_key: string; external_ref: string; core_uid: string | null; request_id: string | null; last_sent_at: Date | null; last_error: string | null }

const day = (d: Date) => d.toISOString().slice(0, 10)

/** Ready to send: nothing blocks it. Warnings ("Check") still send. */
export const isReady = (b: BookingRequest) => !b.issues.some(i => i.blocking)

export type Creator = 'bot' | 'person' | 'unknown'

/**
 * Who made each booking's Salesforce opportunity, by booking key (grouped as
 * buildRequests groups): 'bot' when any hold's is the bot user's, else
 * 'unknown' while any isn't read yet, else 'person'. Pure.
 */
export function creatorsByBooking(holds: Pick<RequestHold, 'id' | 'campaign_group_id' | 'sfdc_opportunity_id' | 'sfdc_created_by_id'>[]): Map<string, Creator> {
  const each = new Map<string, Creator[]>()
  for (const h of holds) {
    const key = bookingKey(h) ?? h.id
    each.set(key, [...(each.get(key) ?? []), opportunityCreator(h)])
  }
  return new Map([...each].map(([k, c]) => [k, c.includes('bot') ? 'bot' : c.includes('unknown') ? 'unknown' : 'person']))
}

export async function loadLedBookings(): Promise<{ bookings: BookingRequest[]; sent: Map<string, SentRow>; creators: Map<string, Creator> }> {
  const today = centralDate(new Date())
  const [holds, links, sent] = await Promise.all([
    prisma.hold.findMany({
      // Won holds stay COMMITTED for good, so history is cut at a year: no
      // booking's markets run a year apart, and a running booking still
      // comes back whole.
      where: { status: { in: ['HOLD', 'EXTENSION_REQUESTED', 'COMMITTED'] }, origination: { not: QUOTE_ONLY_ORIGINATION }, end_date: { gte: new Date(Date.parse(today + 'T00:00:00Z') - 365 * 86_400_000) } },
      select: {
        id: true, truck_number: true, market: true, state: true, client_name: true, start_date: true, end_date: true, status: true,
        campaign_group_id: true, sfdc_opportunity_id: true, sfdc_account_id: true, sfdc_job_number: true, sfdc_created_by_id: true, standard_market_uid: true,
        quoted_total: true, features: true,
      },
    }),
    prisma.ledClientLink.findMany({ select: { sfdc_account_id: true, client_uid: true } }),
    prisma.campaignRequestSync.findMany({ select: { booking_key: true, external_ref: true, core_uid: true, request_id: true, last_sent_at: true, last_error: true } }),
  ])
  const clientOf = new Map(links.map(l => [l.sfdc_account_id, l.client_uid]))
  const rows: RequestHold[] = holds.map(h => ({ ...h, start_date: day(h.start_date), end_date: day(h.end_date) }))
  const sentOf = new Map(sent.map(r => [r.booking_key, r]))
  const bookings = buildRequests(rows, a => clientOf.get(a) ?? null, k => sentOf.get(k)?.external_ref ?? null).filter(b => b.holdsEnd >= today)
  return { bookings, sent: sentOf, creators: creatorsByBooking(holds) }
}

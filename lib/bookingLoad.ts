/**
 * Load a booking's holds by its key (lib/bookings.ts bookingKey), for
 * revising it. Server only.
 */

import { prisma } from '@/lib/prisma'
import { holdReservesNow } from '@/lib/holdFilters'
import { bookingKey, type RevisableHold } from '@/lib/bookings'
import { QUOTE_ONLY_ORIGINATION } from '@/lib/quoteOnly'
import type { LinkedHold } from '@/lib/opportunityMerge'

/** Every hold in the booking, any status (an expired booking can be revised too). */
export async function loadBookingHolds(key: string): Promise<(RevisableHold & { sfdc_opportunity_id: string | null; client_name: string; quoted_total: number | null; expires_at: Date | null })[]> {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(key)) return []
  const rows = await prisma.hold.findMany({
    where: {
      status: { not: 'ATT_SOFT' },
      OR: [
        { campaign_group_id: { startsWith: `${key}_` } },
        { campaign_group_id: key },
        { campaign_group_id: null, sfdc_opportunity_id: key },
      ],
    },
  })
  const now = new Date()
  return rows
    .filter(h => bookingKey(h) === key)
    .map(h => ({
      id: h.id,
      campaign_group_id: h.campaign_group_id,
      sfdc_opportunity_id: h.sfdc_opportunity_id,
      client_name: h.client_name,
      truck_number: h.truck_number,
      market: h.market,
      start_date: h.start_date.toISOString().slice(0, 10),
      end_date: h.end_date.toISOString().slice(0, 10),
      status: h.status,
      source: h.source,
      origination: h.origination,
      features: h.features,
      truck_count: h.truck_count,
      quoted_total: h.quoted_total,
      expires_at: h.expires_at,
      live: holdReservesNow(h, now),
    }))
}

/**
 * The holds that reserve a truck on an opportunity now (lib/opportunityMerge.ts
 * LinkedHold): every booking on it, app-booked or mirrored from Salesforce.
 * A quote-only log reserves nothing and is left out.
 */
export async function loadOpportunityReservingHolds(opportunityId: string): Promise<LinkedHold[]> {
  const rows = await prisma.hold.findMany({
    where: { sfdc_opportunity_id: opportunityId, status: { notIn: ['EXPIRED', 'ATT_SOFT'] } },
  })
  const now = new Date()
  return rows
    .filter(h => h.origination !== QUOTE_ONLY_ORIGINATION && holdReservesNow(h, now))
    .map(h => ({
      truck: h.truck_number,
      market: h.market,
      start: h.start_date.toISOString().slice(0, 10),
      end: h.end_date.toISOString().slice(0, 10),
      expires: h.expires_at ? h.expires_at.toISOString().slice(0, 10) : null,
      fromSalesforce: h.source === 'SALESFORCE',
    }))
}

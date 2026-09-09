import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// EXPIRED holds accumulate forever — every lapsed hold and every Closed Lost
// Opportunity lands here and never leaves. Ops only care about the recent tail,
// so the list carries a rolling window; everything still-active is unaffected.
const EXPIRED_WINDOW_DAYS = 7

/**
 * GET /api/hold-requests
 *
 * Staff-facing unified list of ALL holds — Salesforce, Internal, Client, ATT.
 * Backs the Reservations page at app/hold-requests/page.tsx.
 *
 * EXPIRED holds are limited to the last EXPIRED_WINDOW_DAYS days, keyed on
 * `updated_at` — the moment the row was flipped to EXPIRED, which is what "when
 * did this drop off" means to ops. `expires_at` would be wrong here: it can be
 * null, and for a Closed Lost Opportunity the release has nothing to do with it.
 */
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const expiredCutoff = new Date(Date.now() - EXPIRED_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const holds = await prisma.hold.findMany({
    where: {
      OR: [
        { status: { not: 'EXPIRED' } },
        { status: 'EXPIRED', updated_at: { gte: expiredCutoff } },
      ],
    },
    orderBy:  { created_at: 'desc' },
    include:  {
      client_user: { select: { company_name: true } },
      user: { select: { name: true } },
    },
  })

  return NextResponse.json({
    expired_window_days: EXPIRED_WINDOW_DAYS,
    holdRequests: holds.map((h) => ({
      id:                h.id,
      truck_number:      h.truck_number,
      market:            h.market,
      state:             h.state ?? '',
      start_date:        h.start_date.toISOString().split('T')[0],
      end_date:          h.end_date.toISOString().split('T')[0],
      notes:             h.notes ?? '',
      status:            h.status,
      source:            h.source,
      origination:       h.origination,
      company_name:      h.client_user?.company_name ?? h.client_name,
      created_by_name:   h.user?.name ?? null,
      pricing_tier:      h.pricing_tier ?? null,
      quoted_total:      h.quoted_total ?? null,
      daily_rate:        h.daily_rate ?? null,
      features:          h.features ?? null,
      truck_count:       h.truck_count ?? null,
      campaign_group_id: h.campaign_group_id ?? null,
      sfdc_opportunity_id: h.sfdc_opportunity_id ?? null,
      expires_at:        h.expires_at?.toISOString() ?? null,
      extension_reason:  h.extension_reason ?? null,
      created_at:        h.created_at.toISOString(),
    })),
  })
}

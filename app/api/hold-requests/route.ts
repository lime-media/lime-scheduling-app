import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/hold-requests
 *
 * Staff-facing unified list of ALL holds — Salesforce, Internal, Client, ATT.
 * Backs the Reservations page at app/hold-requests/page.tsx.
 */
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const holds = await prisma.hold.findMany({
    orderBy:  { created_at: 'desc' },
    include:  {
      client_user: { select: { company_name: true } },
      user: { select: { name: true } },
    },
  })

  return NextResponse.json({
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

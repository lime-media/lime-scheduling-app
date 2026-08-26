import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/hold-requests
 *
 * Staff-facing list of every client's HoldRequest rows (across all clients — unlike
 * /api/client/hold-requests, which is scoped to one logged-in client). Backs the internal
 * review page at app/hold-requests/page.tsx: approve/reject/extension-decision actions live
 * in app/api/hold-requests/[id]/route.ts.
 */
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const requests = await prisma.holdRequest.findMany({
    orderBy:  { created_at: 'desc' },
    include:  { client_user: { select: { company_name: true } } },
  })

  return NextResponse.json({
    holdRequests: requests.map((r) => ({
      id:                r.id,
      truck_number:      r.truck_number,
      market:            r.market,
      state:             r.state ?? '',
      start_date:        r.start_date.toISOString().split('T')[0],
      end_date:          r.end_date.toISOString().split('T')[0],
      notes:             r.notes ?? '',
      status:            r.status,
      company_name:      r.client_user.company_name,
      pricing_tier:      r.pricing_tier ?? null,
      quoted_total:      r.quoted_total ?? null,
      daily_rate:        r.daily_rate ?? null,
      truck_count:       r.truck_count ?? null,
      campaign_group_id: r.campaign_group_id ?? null,
      expires_at:        r.expires_at?.toISOString() ?? null,
      extension_reason:  r.extension_reason ?? null,
      created_at:        r.created_at.toISOString(),
    })),
  })
}

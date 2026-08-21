import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getClientSession } from '@/lib/clientAuth'
import { createHoldRequestForClient } from '@/lib/holdRequestService'

export async function GET(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const requests = await prisma.holdRequest.findMany({
    where:   { client_user_id: session.id },
    orderBy: { created_at: 'desc' },
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
      company_name:      session.companyName,
      pricing_tier:      r.pricing_tier ?? null,
      quoted_total:      r.quoted_total ?? null,
      daily_rate:        r.daily_rate ?? null,
      features:          r.features ?? null,
      truck_count:       r.truck_count ?? null,
      campaign_group_id: r.campaign_group_id ?? null,
      expires_at:        r.expires_at?.toISOString() ?? null,
    })),
  })
}

export async function POST(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { truck_number, market, state, start_date, end_date, notes } = await req.json()
    if (!truck_number || !start_date || !end_date) {
      return NextResponse.json({ error: 'truck_number, start_date, end_date required' }, { status: 400 })
    }

    const holdRequest = await createHoldRequestForClient(session, {
      truck_number, market, state, start_date, end_date, notes,
    })

    return NextResponse.json({ ok: true, id: holdRequest.id })
  } catch (e) {
    console.error('[client/hold-requests POST]', e)
    return NextResponse.json({ error: 'Failed to create hold request' }, { status: 500 })
  }
}

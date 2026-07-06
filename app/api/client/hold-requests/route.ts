import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getClientSession } from '@/lib/clientAuth'
import { sendHoldRequestEmail } from '@/lib/email'

export async function GET(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const requests = await prisma.holdRequest.findMany({
    where:   { client_user_id: session.id },
    orderBy: { created_at: 'desc' },
  })

  return NextResponse.json({
    holdRequests: requests.map((r) => ({
      id:           r.id,
      truck_number: r.truck_number,
      market:       r.market,
      state:        r.state ?? '',
      start_date:   r.start_date.toISOString().split('T')[0],
      end_date:     r.end_date.toISOString().split('T')[0],
      notes:        r.notes ?? '',
      status:       r.status,
      company_name: session.companyName,
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

    const holdRequest = await prisma.holdRequest.create({
      data: {
        client_user_id: session.id,
        truck_number,
        market:     market    ?? '',
        state:      state     ?? null,
        start_date: new Date(start_date),
        end_date:   new Date(end_date),
        notes:      notes     ?? null,
        status:     'PENDING',
      },
    })

    // Send email notification (no-op if SMTP not configured)
    await sendHoldRequestEmail({
      companyName: session.companyName,
      truckNumber: truck_number,
      market:      market ?? '',
      startDate:   start_date,
      endDate:     end_date,
      notes:       notes,
    }).catch((e) => console.error('[email] send failed:', e))

    return NextResponse.json({ ok: true, id: holdRequest.id })
  } catch (e) {
    console.error('[client/hold-requests POST]', e)
    return NextResponse.json({ error: 'Failed to create hold request' }, { status: 500 })
  }
}

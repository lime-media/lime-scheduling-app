import { withUsageLog } from '@/lib/usageLog'
import { NextRequest, NextResponse } from 'next/server'
import { QUOTE_ONLY_ORIGINATION } from '@/lib/quoteOnly'
import { prisma } from '@/lib/prisma'
import { getClientSession } from '@/lib/clientAuth'
import { placeClientBooking } from '@/lib/clientBooking'
import { createClientHold } from '@/lib/holdRequestService'
import { bookingKey } from '@/lib/bookings'

export async function GET(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const holds = await prisma.hold.findMany({
    // Internal quote-only logs are never shown to the client.
    where:   { client_user_id: session.id, NOT: { origination: QUOTE_ONLY_ORIGINATION } },
    orderBy: { created_at: 'desc' },
  })

  // The booking each hold belongs to (lib/bookings.ts bookingKey): the portal
  // shows and extends a booking as one, not a card per market. Sent as an
  // opaque label, since a key can be a Salesforce opportunity id.
  const labels = new Map<string, string>()
  const bookingOf = (r: typeof holds[number]) => {
    const key = bookingKey(r)
    if (!key) return null
    if (!labels.has(key)) labels.set(key, `b${labels.size + 1}`)
    return labels.get(key)!
  }

  return NextResponse.json({
    holdRequests: holds.map((r) => ({
      id:                r.id,
      booking:           bookingOf(r),
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
      extension_until:   r.extension_until?.toISOString().split('T')[0] ?? null,
      extension_reason:  r.extension_reason ?? null,
    })),
  })
}

async function handlePost(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()

    // Auto-select trucks when truck_number is not provided.
    if (!body.truck_number && body.market && body.start_date && body.end_date && body.truck_count) {
      // Returned, not awaited, as before the move: a throw from the booking
      // propagates to withUsageLog (which logs the real error) instead of the
      // generic catch below.
      return placeClientBooking(session, body)
        .then(result => NextResponse.json(result.body, { status: result.status }))
    }

    // Legacy flow: client provides a specific truck_number (drag-on-grid)
    const { truck_number, market, state, start_date, end_date, notes } = body
    if (!truck_number || !start_date || !end_date) {
      return NextResponse.json({ error: 'truck_number, start_date, end_date required' }, { status: 400 })
    }

    const hold = await createClientHold(session, {
      truck_number, market, state, start_date, end_date, notes,
    })

    return NextResponse.json({ ok: true, id: hold.id })
  } catch (e) {
    console.error('[client/hold-requests POST]', e)
    return NextResponse.json({ error: 'Failed to create hold' }, { status: 500 })
  }
}


// Every run is logged for the Usage page (lib/usageLog.ts).
export const POST = withUsageLog('hold_client', 'client', handlePost)

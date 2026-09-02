import { NextRequest, NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { prisma } from '@/lib/prisma'
import { createHold } from '@/lib/holdService'
import { sendHoldRequestEmail } from '@/lib/email'
import { appendHoldRequestToSheet } from '@/lib/googleSheets'
import { computeHoldExpiresAt } from '@/lib/holdRequestService'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'

export async function POST(req: NextRequest) {
  const keyError = validateInternalApiKey(req)
  if (keyError) return keyError

  const actingUserId = req.headers.get('x-acting-user-id')
  if (!actingUserId) {
    return NextResponse.json({ error: 'Missing X-Acting-User-Id header' }, { status: 400 })
  }

  const actingUserType = req.headers.get('x-acting-user-type') || 'app_user'
  if (actingUserType !== 'app_user' && actingUserType !== 'client_user') {
    return NextResponse.json({ error: 'X-Acting-User-Type must be "app_user" or "client_user"' }, { status: 400 })
  }

  const body = await req.json()
  const { truck_number, market, state, client_name, start_date, end_date, status, notes } = body

  if (!truck_number || !start_date || !end_date) {
    return NextResponse.json({ error: 'Missing required fields: truck_number, start_date, end_date' }, { status: 400 })
  }

  // Client users create holds directly (same as client view flow)
  if (actingUserType === 'client_user') {
    const clientUser = await prisma.clientUser.findUnique({ where: { id: actingUserId } })
    if (!clientUser) {
      return NextResponse.json({ error: 'Acting client user not found' }, { status: 404 })
    }

    const serviceUser = await prisma.user.findFirst({
      where: { email: SFDC_SERVICE_USER_EMAIL },
      select: { id: true },
    })
    if (!serviceUser) {
      return NextResponse.json({ error: 'Service user not found' }, { status: 500 })
    }

    const expiresAt = computeHoldExpiresAt(start_date)

    // Conflict check — same as the app_user path via createHold()
    const conflicts = await prisma.hold.findMany({
      where: {
        truck_number,
        status: { notIn: ['EXPIRED', 'ATT_SOFT'] },
        start_date: { lte: new Date(end_date) },
        end_date: { gte: new Date(start_date) },
      },
    })
    if (conflicts.length > 0) {
      const c = conflicts[0]
      return NextResponse.json({
        error: `Truck ${truck_number} already has a ${c.status} for "${c.client_name}" from ${c.start_date.toISOString().split('T')[0]} to ${c.end_date.toISOString().split('T')[0]}.`,
      }, { status: 409 })
    }

    const hold = await prisma.hold.create({
      data: {
        truck_number,
        client_name:    clientUser.company_name,
        market:         market ?? '',
        state:          state  ?? '',
        start_date:     new Date(start_date),
        end_date:       new Date(end_date),
        status:         'HOLD',
        source:         'CLIENT',
        origination:    'mcp',
        notes:          notes ?? null,
        created_by:     serviceUser.id,
        client_user_id: actingUserId,
        expires_at:     expiresAt,
      },
    })

    // Fire-and-forget side effects
    if (clientUser.company_name === 'Firefly' && clientUser.username === 'firefly') {
      appendHoldRequestToSheet({
        submittedAt:  new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }),
        companyName:  clientUser.company_name,
        truckNumber:  truck_number,
        market:       market ?? '',
        state:        state  ?? '',
        startDate:    start_date,
        endDate:      end_date,
        notes:        notes  ?? '',
        status:       'HOLD',
      }).catch((e) => console.error('[mcp/holds] sheets append failed:', e))
    }

    sendHoldRequestEmail({
      companyName: clientUser.company_name,
      truckNumber: truck_number,
      market:      market ?? '',
      startDate:   start_date,
      endDate:     end_date,
      notes:       notes,
    }).catch((e) => console.error('[mcp/holds] email send failed:', e))

    return NextResponse.json({
      type: 'hold',
      id: hold.id,
      truck_number: hold.truck_number,
      market: hold.market,
      state: hold.state,
      start_date: hold.start_date.toISOString().split('T')[0],
      end_date: hold.end_date.toISOString().split('T')[0],
      status: hold.status,
      source: hold.source,
      company_name: clientUser.company_name,
    }, { status: 201 })
  }

  // App users create actual holds
  const user = await prisma.user.findUnique({ where: { id: actingUserId } })
  if (!user) {
    return NextResponse.json({ error: 'Acting user not found' }, { status: 404 })
  }

  if (!market || !state || !client_name) {
    return NextResponse.json({ error: 'Missing required fields for hold: market, state, client_name' }, { status: 400 })
  }

  const result = await createHold({
    truck_number,
    market,
    state,
    client_name,
    start_date,
    end_date,
    status,
    notes,
    created_by: actingUserId,
    origination: 'mcp',
  })

  if (!result.success) {
    return NextResponse.json({ error: result.error.message }, { status: 409 })
  }

  // Return the hold with user info, matching the shape the front-end sees
  const hold = await prisma.hold.findUnique({
    where: { id: result.hold.id },
    include: { user: { select: { name: true, email: true } } },
  })

  return NextResponse.json({ type: 'hold', ...hold }, { status: 201 })
}

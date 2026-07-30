import { NextRequest, NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { prisma } from '@/lib/prisma'
import { createHold } from '@/lib/holdService'

export async function POST(req: NextRequest) {
  const keyError = validateInternalApiKey(req)
  if (keyError) return keyError

  const actingUserId = req.headers.get('x-acting-user-id')
  if (!actingUserId) {
    return NextResponse.json({ error: 'Missing X-Acting-User-Id header' }, { status: 400 })
  }

  // Verify the acting user exists
  const user = await prisma.user.findUnique({ where: { id: actingUserId } })
  if (!user) {
    return NextResponse.json({ error: 'Acting user not found' }, { status: 404 })
  }

  const body = await req.json()
  const { truck_number, market, state, client_name, start_date, end_date, status, notes } = body

  if (!truck_number || !market || !state || !client_name || !start_date || !end_date) {
    return NextResponse.json({ error: 'Missing required fields: truck_number, market, state, client_name, start_date, end_date' }, { status: 400 })
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

  return NextResponse.json(hold, { status: 201 })
}

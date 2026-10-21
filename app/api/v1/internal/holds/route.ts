import { NextRequest, NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { prisma } from '@/lib/prisma'
import { mcpParty } from '@/lib/mcpActing'
import { placeClientBooking, type ClientBookingInput } from '@/lib/clientBooking'
import { placeStaffBooking } from '@/lib/staffBooking'
import { appendHoldRequestToSheet } from '@/lib/googleSheets'

/**
 * POST /api/v1/internal/holds: the MCP server's booking.
 *
 * A booking is a market, dates and a truck count, booked by the same code as
 * the app for whoever the call acts for (lib/mcpActing.ts):
 * - a client gets the client portal's booking (lib/clientBooking.ts): the
 *   engine picks the trucks, the price is recomputed, holds get the client
 *   expiry, the team is emailed and the opportunity is created on the
 *   client's Salesforce account;
 * - a staff member gets the Quote page's (lib/staffBooking.ts): it needs the
 *   Salesforce account and its primary contact, as the Quote page does, and
 *   gets the staff expiry, the opportunity and the price check
 *   (expected_total, when given).
 * Holds are marked origination 'mcp' ("Via MCP" on the schedule).
 *
 * Booking a named truck is no longer offered: the caller couldn't see
 * transport or chain feasibility, and it skipped pricing, expiry and
 * Salesforce. The engine picks the trucks, as everywhere else.
 */
export async function POST(req: NextRequest) {
  const keyError = validateInternalApiKey(req)
  if (keyError) return keyError

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  if (body.truck_number !== undefined) {
    return NextResponse.json({ error: 'Booking a named truck is no longer supported. Book a market, dates and truck_count; the trucks are picked for you.' }, { status: 400 })
  }
  const { market, start_date, end_date, truck_count } = body
  if (typeof market !== 'string' || !market.trim() || typeof start_date !== 'string' || typeof end_date !== 'string'
    || typeof truck_count !== 'number' || !Number.isInteger(truck_count) || truck_count < 1) {
    return NextResponse.json({ error: 'market, start_date, end_date (YYYY-MM-DD) and truck_count (a whole number, at least 1) are required' }, { status: 400 })
  }

  const party = await mcpParty(req)
  if (party.kind === 'error') return NextResponse.json({ error: party.error }, { status: party.status })

  const features = {
    shadow_fencing: body.shadow_fencing, smart_directional: body.smart_directional, device_id: body.device_id,
    studies: body.studies, days_per_week: body.days_per_week, operating_hours: body.operating_hours,
  }

  if (party.kind === 'client') {
    const result = await placeClientBooking(party.session, {
      market, start_date, end_date, truck_count, ...features,
      state: typeof body.state === 'string' ? body.state : undefined,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      brand: typeof body.brand === 'string' ? body.brand : undefined,
    } as ClientBookingInput, { origination: 'mcp' })
    // Firefly's bookings also go to their sheet, as MCP holds always have.
    const groupId = result.body.campaignGroupId
    if (result.status === 200 && typeof groupId === 'string' && party.session.companyName === 'Firefly' && party.session.username === 'firefly') {
      const held = await prisma.hold.findMany({ where: { campaign_group_id: groupId }, select: { truck_number: true, market: true, state: true } })
      for (const h of held) {
        appendHoldRequestToSheet({
          submittedAt: new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }),
          companyName: party.session.companyName, truckNumber: h.truck_number, market: h.market, state: h.state ?? '',
          startDate: start_date, endDate: end_date, notes: typeof body.notes === 'string' ? body.notes : '', status: 'HOLD',
        }).catch((e) => console.error('[mcp/holds] sheets append failed:', e))
      }
    }
    return NextResponse.json(result.body, { status: result.status })
  }

  // Staff: the Quote page's booking, with only the fields it takes.
  const result = await placeStaffBooking({
    market, start_date, end_date, truck_count, ...features,
    state: body.state, sfdc_account_id: body.sfdc_account_id, sfdc_account_name: body.sfdc_account_name,
    primary_contact_id: body.primary_contact_id, brand: body.brand, hold_days: body.hold_days, stage: body.stage,
    brand_markup_pct: body.brand_markup_pct, expected_total: body.expected_total,
  }, party.actor, { origination: 'mcp' })
  return NextResponse.json(result.body, { status: result.status })
}

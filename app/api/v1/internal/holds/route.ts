import { NextRequest, NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere } from '@/lib/holdFilters'
import { mcpParty, parseMcpCampaign, parseMcpStaffPricing } from '@/lib/mcpActing'
import { resolveQuoteMarket } from '@/lib/staffQuote'
import { placeClientBooking } from '@/lib/clientBooking'
import { placeStaffBooking } from '@/lib/staffBooking'

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
  const campaign = parseMcpCampaign(body)
  if ('error' in campaign) return NextResponse.json({ error: campaign.error }, { status: 400 })

  const party = await mcpParty(req)
  if (party.kind === 'error') return NextResponse.json({ error: party.error }, { status: party.status })

  // Staff fields, checked before any lookup (cheap checks first). Priced as
  // the MCP quote prices it (the same markup check), and named: a booking with
  // no account name would be held as "Unknown" with a "Client - …"
  // opportunity. null is "not given".
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const staff = party.kind === 'staff' ? parseMcpStaffPricing(body) : null
  if (staff && 'error' in staff) return NextResponse.json({ error: staff.error }, { status: 400 })
  const accountName = str(body.sfdc_account_name)?.trim()
  const expectedTotal = body.expected_total ?? undefined
  if (party.kind === 'staff') {
    if (!accountName) return NextResponse.json({ error: 'sfdc_account_name is required: the Salesforce Account the booking is for' }, { status: 400 })
    if (expectedTotal !== undefined && (typeof expectedTotal !== 'number' || !Number.isFinite(expectedTotal))) {
      return NextResponse.json({ error: "expected_total must be a number (the quote's grandTotal)" }, { status: 400 })
    }
  }

  // The market as the quote resolved it (one formal "City, ST" in the
  // contiguous 48, or the same refusal): the booking functions take the
  // portal's and Quote page's already-resolved market, so a raw "Springfield"
  // or ZIP would otherwise be booked unresolved, at a price the quote didn't give.
  const resolved = await resolveQuoteMarket(campaign.market)
  if ('status' in resolved) return NextResponse.json(resolved.body, { status: resolved.status })
  const booking = { ...campaign, market: resolved.formal }
  const { start_date, end_date } = booking

  // A second booking of the same campaign (a retry after a timeout, or a
  // repeat) isn't refused, but the caller must confirm it: the same caller's
  // live booking for these dates in the last day is named, and booking again
  // needs confirm_duplicate: true.
  if (body.confirm_duplicate !== true) {
    const existing = await prisma.hold.findMany({
      where: {
        ...activeHoldWhere(),
        ...(party.kind === 'client' ? { client_user_id: party.session.id } : { created_by: party.actor.id }),
        start_date: new Date(start_date), end_date: new Date(end_date),
        created_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      select: { truck_number: true, market: true, campaign_group_id: true, created_at: true },
      orderBy: { created_at: 'desc' },
    })
    if (existing.length) {
      const trucks = existing.map(h => h.truck_number).join(', ')
      return NextResponse.json({
        duplicate: true,
        existing: { market: existing[0].market, start_date, end_date, trucks: existing.map(h => h.truck_number), booked_at: existing[0].created_at.toISOString() },
        message: `You already booked ${start_date} to ${end_date} in ${existing[0].market} in the last day (truck${existing.length === 1 ? '' : 's'} ${trucks}). Ask the person whether they mean a second booking; to book again, call again with confirm_duplicate: true.`,
      }, { status: 409 })
    }
  }

  if (party.kind === 'client') {
    const result = await placeClientBooking(party.session, {
      ...booking,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      brand: typeof body.brand === 'string' ? body.brand : undefined,
    }, { origination: 'mcp' })
    // Firefly's sheet rows are appended per hold by createClientHold (lib/holdRequestService.ts).
    return NextResponse.json(result.body, { status: result.status })
  }

  // Staff: the Quote page's booking, with only the fields it takes (checked
  // above; hold_days by placeStaffBooking). Notes go to the opportunity, not
  // the hold (lib/staffBooking.ts).
  const result = await placeStaffBooking({
    ...booking,
    ...staff,
    sfdc_account_name: accountName,
    primary_contact_id: str(body.primary_contact_id), brand: str(body.brand), hold_days: body.hold_days, stage: str(body.stage),
    notes: str(body.notes), expected_total: expectedTotal,
  }, party.actor, { origination: 'mcp' })
  return NextResponse.json(result.body, { status: result.status })
}

import { NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { mcpParty } from '@/lib/mcpActing'
import { clientQuote, type ClientQuoteInput } from '@/lib/clientQuote'
import { staffQuote, type StaffQuoteInput } from '@/lib/staffQuote'

/**
 * POST /api/v1/internal/quote: the MCP server's quote.
 *
 * The same quote as the app, for whoever the call acts for (lib/mcpActing.ts):
 * a client gets the client portal's quote (lib/clientQuote.ts: their rate
 * agreement, the lead-time minimum, real trucks and transport, no fleet
 * detail); a staff member gets the Quote page's (lib/staffQuote.ts, with an
 * optional sfdc_account_id for agreement and Brand Direct pricing). This route
 * prices nothing itself. It used to estimate every truck at the nearest
 * accepted market and take the market size tier from the caller.
 *
 * Body: market, start_date, end_date, truck_count; optional shadow_fencing,
 * smart_directional, device_id, studies, days_per_week, operating_hours;
 * staff only: sfdc_account_id, brand_markup_pct.
 */

export async function POST(request: Request) {
  const authError = validateInternalApiKey(request)
  if (authError) return authError

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  const party = await mcpParty(request)
  if (party.kind === 'error') return NextResponse.json({ error: party.error }, { status: party.status })

  const common = {
    market: body.market, start_date: body.start_date, end_date: body.end_date, truck_count: body.truck_count,
    shadow_fencing: body.shadow_fencing, smart_directional: body.smart_directional, device_id: body.device_id,
    studies: body.studies, days_per_week: body.days_per_week, operating_hours: body.operating_hours,
  }
  if (typeof common.market !== 'string' || typeof common.start_date !== 'string' || typeof common.end_date !== 'string'
    || typeof common.truck_count !== 'number' || !Number.isInteger(common.truck_count) || common.truck_count < 1) {
    return NextResponse.json({ error: 'market, start_date, end_date (YYYY-MM-DD) and truck_count (a whole number, at least 1) are required' }, { status: 400 })
  }

  const result = party.kind === 'client'
    // A client can't name another account or set a markup: the session's own apply.
    ? await clientQuote(party.session, common as ClientQuoteInput)
    : await staffQuote({
        ...common,
        sfdc_account_id: typeof body.sfdc_account_id === 'string' ? body.sfdc_account_id : undefined,
        brand_markup_pct: typeof body.brand_markup_pct === 'number' ? body.brand_markup_pct : undefined,
      } as StaffQuoteInput)
  return NextResponse.json(result.body, { status: result.status })
}

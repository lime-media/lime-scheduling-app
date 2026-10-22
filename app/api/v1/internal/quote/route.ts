import { NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { mcpParty, parseMcpCampaign, parseMcpStaffPricing } from '@/lib/mcpActing'
import { clientQuote } from '@/lib/clientQuote'
import { staffQuote } from '@/lib/staffQuote'

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

  const common = parseMcpCampaign(body)
  if ('error' in common) return NextResponse.json({ error: common.error }, { status: 400 })

  const party = await mcpParty(request)
  if (party.kind === 'error') return NextResponse.json({ error: party.error }, { status: party.status })

  // A client can't name another account or set a markup: the session's own apply.
  if (party.kind === 'client') {
    const result = await clientQuote(party.session, common)
    return NextResponse.json(result.body, { status: result.status })
  }
  const pricing = parseMcpStaffPricing(body)
  if ('error' in pricing) return NextResponse.json({ error: pricing.error }, { status: 400 })
  const result = await staffQuote({ ...common, ...pricing })
  return NextResponse.json(result.body, { status: result.status })
}

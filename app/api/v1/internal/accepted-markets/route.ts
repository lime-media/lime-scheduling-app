import { NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { SERVICE_AREA_RADIUS_MILES } from '@/lib/pricing'
import { resolveDefaultRateOverrides } from '@/lib/pricing/resolvers'

/**
 * GET /api/v1/internal/accepted-markets — where Lime serves, for the MCP
 * server's get_service_area tool.
 *
 * Partners quote the way the Quote Builder does: any city, town or ZIP in the
 * contiguous 48 states. There is no list of markets to choose from, so none is
 * returned (this used to send 50 "accepted" DMAs, which only ever ranked a
 * market for its impressions; lib/pricing/topDmas.ts). The path is kept so the
 * deployed MCP server keeps working.
 *
 * The radius is the default rate card's (else config.ts). A client's rate
 * agreement can set its own radius or include transport, so the quote, which
 * applies the caller's agreement, is the answer for a given market.
 */
export async function GET(request: Request) {
  const authError = validateInternalApiKey(request)
  if (authError) return authError

  // Never throws: no default rate card, or a failed read, gives the configured radius.
  const defaults = await resolveDefaultRateOverrides()
  const radius = defaults?.service_area_miles ?? SERVICE_AREA_RADIUS_MILES

  return NextResponse.json({
    service_area: 'contiguous_48_states',
    description: 'Lime serves campaigns in any city, town or ZIP in the contiguous 48 US states (not Alaska or Hawaii). There is no list of markets to pick from.',
    service_area_radius_miles: radius,
    transport: `By default, trucks within ${radius} miles of the market need no transport; from further away, transport is shown on the quote, billed or, for a campaign of 10+ activation days booked 10+ business days ahead, absorbed by Lime. A client's rate agreement can set its own radius or include transport, so the quote is the answer for a given market.`,
    how_to_check_a_market: 'Quote it: get_rate_quote places the market, applies your rate agreement, and says if it cannot serve it.',
  })
}

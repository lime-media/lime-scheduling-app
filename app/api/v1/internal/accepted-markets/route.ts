import { NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { SERVICE_AREA_RADIUS_MILES } from '@/lib/pricing'
import { resolveDefaultRateOverrides, resolveRateOverrides } from '@/lib/pricing/resolvers'
import { mcpParty } from '@/lib/mcpActing'

/**
 * GET /api/v1/internal/accepted-markets — where Lime serves, for the MCP
 * server's get_service_area tool.
 *
 * Partners quote the way the Quote Builder does: any city, town or ZIP in the
 * contiguous 48 states, priced from the nearest available truck with transport
 * beyond the radius. There is no list of markets to choose from, so none is
 * returned (this used to send 50 "accepted" DMAs, which only ever ranked a
 * market for its impressions; lib/pricing/topDmas.ts). The path is kept so the
 * deployed MCP server keeps working.
 *
 * The radius is the one the caller's quotes use: the client's rate agreement,
 * else the editable default rate card, else config.ts (as clientAvailability
 * and the staff availability route resolve it). Acting headers are optional so
 * an MCP server that doesn't send them still gets the default rate card's.
 */
export async function GET(request: Request) {
  const authError = validateInternalApiKey(request)
  if (authError) return authError

  const party = request.headers.get('x-acting-user-id') ? await mcpParty(request) : null
  const [defaults, client] = await Promise.all([
    resolveDefaultRateOverrides(),
    party?.kind === 'client' ? resolveRateOverrides(party.session) : Promise.resolve(null),
  ])
  const radius = client?.service_area_miles ?? defaults?.service_area_miles ?? SERVICE_AREA_RADIUS_MILES

  return NextResponse.json({
    service_area: 'contiguous_48_states',
    description: 'Lime serves campaigns in any city, town or ZIP in the contiguous 48 US states (not Alaska or Hawaii). There is no list of markets to pick from.',
    service_area_radius_miles: radius,
    transport: `Trucks within ${radius} miles of the market need no transport. From further away, transport is shown on the quote: billed, or included at no charge when the dates allow.`,
    how_to_check_a_market: 'Quote it: get_rate_quote places the market and says if it cannot.',
  })
}

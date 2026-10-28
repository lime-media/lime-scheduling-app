import { NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { SERVICE_AREA_RADIUS_MILES } from '@/lib/pricing'

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
 */
export async function GET(request: Request) {
  const authError = validateInternalApiKey(request)
  if (authError) return authError

  return NextResponse.json({
    service_area: 'contiguous_48_states',
    description: 'Lime serves campaigns in any city, town or ZIP in the contiguous 48 US states (not Alaska or Hawaii).',
    markets: 'any_us_city_town_or_zip',
    service_area_radius_miles: SERVICE_AREA_RADIUS_MILES,
    transport: `Trucks within ${SERVICE_AREA_RADIUS_MILES} miles reposition at no charge; from further away, transport is priced on the quote.`,
    how_to_check_a_market: 'Quote it: get_rate_quote places the market and says if it cannot.',
  })
}

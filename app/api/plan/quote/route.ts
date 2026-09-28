/**
 * POST /api/plan/quote — price and route a multi-market order.
 *
 * Internal staff only. The response carries truck numbers and the transport we
 * absorb, neither of which may reach a client route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/planning/http'
import { buildMultiMarketQuote, resolveRows, validateQuoteRequest, type QuoteRequest } from '@/lib/planning/quote'

// Loads the fleet, routes the order, then reruns it for each alternative.
export const maxDuration = 300


export async function POST(req: NextRequest) {
  const denied = await requireStaff(req)
  if (denied) return denied

  let body: QuoteRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  body.features = body.features ?? { shadowFencing: true, smartDirectional: false, deviceId: false }
  const invalid = validateQuoteRequest(body)
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })

  try {
    const { lines, errors } = await resolveRows(body.rows)
    if (errors.length) return NextResponse.json({ error: 'Some markets need attention.', rowErrors: errors }, { status: 400 })
    const { quote } = await buildMultiMarketQuote(body, lines)
    return NextResponse.json(quote)
  } catch (err) {
    console.error('[plan/quote] failed:', err)
    return NextResponse.json({ error: 'The quote could not be built. Check the server log.' }, { status: 500 })
  }
}

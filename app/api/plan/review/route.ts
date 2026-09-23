/**
 * POST /api/plan/review — Claude reads the ZIP list for problems geometry
 * cannot see (labels naming the wrong city, digit slips). Suggested ZIPs are
 * verified in code against the Census centroids before they are shown.
 */

import { NextRequest, NextResponse } from 'next/server'
import { reviewFootprint } from '@/lib/planning/claude'
import { requireStaff, claudeErrorResponse } from '@/lib/planning/http'
import { loadStandardMarketCoords, titleCaseMarket } from '@/lib/marketBounds'
import type { Area, AreaFlag, Centroids, ZipRow } from '@/lib/planning/areas'
import centroidData from '@/lib/planning/data/zcta-centroids.json'

export const maxDuration = 300

const centroids = centroidData as unknown as Centroids

export async function POST(req: NextRequest) {
  const denied = await requireStaff(req)
  if (denied) return denied

  let body: { rows?: ZipRow[]; areas?: Area[]; flags?: AreaFlag[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!Array.isArray(body.rows) || !Array.isArray(body.areas) || body.rows.length === 0 || body.rows.length > 5000) {
    return NextResponse.json({ error: 'Build the areas first (review supports up to 5,000 ZIPs).' }, { status: 400 })
  }

  try {
    const marketCoords = await loadStandardMarketCoords()
    const markets = new Map([...marketCoords].map(([k, v]) => [titleCaseMarket(k), v]))
    const findings = await reviewFootprint({ rows: body.rows, areas: body.areas, flags: body.flags ?? [], centroids, markets })
    return NextResponse.json({ findings })
  } catch (err) {
    return claudeErrorResponse(err, 'review')
  }
}

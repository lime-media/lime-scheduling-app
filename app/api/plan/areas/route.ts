/**
 * POST /api/plan/areas — client ZIP list -> coverage areas.
 *
 * Internal staff only. Parses pasted CSV/TSV, geocodes each ZIP against the
 * Census ZIP centroids, groups ZIPs into areas and returns every correction it
 * made (duplicates, PO boxes, probable typos) as flags for the rep.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { buildAreas, parseZipRows, type Centroids } from '@/lib/planning/areas'
import { loadStandardMarketCoords, titleCaseMarket } from '@/lib/marketBounds'
import centroidData from '@/lib/planning/data/zcta-centroids.json'

const centroids = centroidData as unknown as Centroids
const MAX_TEXT = 2_000_000

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { text?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const text = typeof body.text === 'string' ? body.text : ''
  if (!text.trim()) return NextResponse.json({ error: 'Paste or upload the client ZIP list first.' }, { status: 400 })
  if (text.length > MAX_TEXT) return NextResponse.json({ error: 'That file is too large.' }, { status: 413 })

  const parsed = parseZipRows(text)
  if (parsed.rows.length === 0) {
    return NextResponse.json({ error: 'No ZIP codes found. Include a header row with a "Zip" column, or use the order DMA, Zip, City, State.' }, { status: 400 })
  }

  const marketCoords = await loadStandardMarketCoords()
  const markets = new Map([...marketCoords].map(([k, v]) => [titleCaseMarket(k), v]))
  const result = buildAreas(parsed.rows, centroids, markets)
  return NextResponse.json({ ...result, flags: [...parsed.flags, ...result.flags] })
}

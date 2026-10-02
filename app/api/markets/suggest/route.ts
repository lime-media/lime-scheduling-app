/**
 * GET /api/markets/suggest?q=… — market suggestions as a rep or client types.
 *
 * Standard markets first (the list the team maintains, with boundaries), then
 * any US city or town (lib/geo/places.ts), so a college town an hour from the
 * nearest standard market is still one click away. A 5-digit ZIP suggests the
 * place it is in. Staff and client-portal sessions both.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { getClientSession } from '@/lib/clientAuth'
import { loadStandardMarketCoords, normalizeMarketKey, titleCaseMarket } from '@/lib/marketBounds'
import { placeForZip, suggestPlaces } from '@/lib/geo/places'

const LIMIT = 8

export async function GET(req: NextRequest) {
  const staff = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!staff && !getClientSession(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 80)
  if (q.length < 3) return NextResponse.json({ suggestions: [] })

  const zip = placeForZip(q)
  if (zip) return NextResponse.json({ suggestions: [{ name: zip.name, kind: 'place' }] })

  const key = normalizeMarketKey(q)
  const [city, state] = [key.split(',')[0].trim(), key.split(',')[1]?.trim()]
  const out: { name: string; kind: 'standard' | 'place' }[] = []
  const seen = new Set<string>()
  try {
    const standard = await loadStandardMarketCoords()
    const hits = [...standard.keys()]
      .filter(k => k.split(',')[0].trim().startsWith(city) && (!state || (k.split(',')[1]?.trim() ?? '').startsWith(state)))
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
    for (const k of hits.slice(0, LIMIT)) {
      out.push({ name: titleCaseMarket(k), kind: 'standard' })
      seen.add(normalizeMarketKey(k))
    }
  } catch (err) {
    console.error('[markets/suggest] standard markets unavailable:', err)
  }
  for (const p of suggestPlaces(q, LIMIT)) {
    if (out.length >= LIMIT) break
    if (seen.has(normalizeMarketKey(p.name))) continue
    out.push({ name: p.name, kind: 'place' })
  }
  return NextResponse.json({ suggestions: out })
}

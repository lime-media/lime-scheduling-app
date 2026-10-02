/**
 * Every US city, town and village in the contiguous 48 states (plus DC), from
 * the Census Bureau's 2024 Gazetteer place file (public domain), so a quote can
 * be placed anywhere — a college town an hour from the nearest standard
 * market included. Also ZIP codes, from the Census ZCTA centroids the planner
 * already ships.
 *
 * This is the FALLBACK. The standard market list (dbo.standard_market_lookup)
 * always wins where it knows a market; this only answers for places it does
 * not. Server-only: the data is ~1.6 MB and must never reach a browser bundle.
 *
 * Regenerate: scripts/build-us-places.py (see its header).
 */

import placesData from '@/lib/geo/data/us-places.json'
import zctaData from '@/lib/planning/data/zcta-centroids.json'
import { haversineDistance } from '@/lib/marketCoordinates'

/** [display name "Ames, IA", lat, lng], keyed "ames, ia". */
type Row = [string, number, number]
const PLACES = placesData as unknown as Record<string, Row>
const ZCTA = zctaData as unknown as Record<string, [number, number]>

export type Place = { name: string; lat: number; lng: number }

const key = (s: string) => s.trim().toLowerCase().replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').replace(/\./g, '')
const toPlace = (r: Row): Place => ({ name: r[0], lat: r[1], lng: r[2] })

// City name → every "city, st" key with it, built once on first use.
let byCity: Map<string, string[]> | null = null
function cityIndex(): Map<string, string[]> {
  if (byCity) return byCity
  byCity = new Map()
  for (const k of Object.keys(PLACES)) {
    const city = k.slice(0, k.lastIndexOf(', '))
    const list = byCity.get(city)
    if (list) list.push(k)
    else byCity.set(city, [k])
  }
  return byCity
}

/** A 5-digit ZIP: its centroid, named after the nearest place within 25 miles. */
export function placeForZip(zip: string): Place | null {
  const z = zip.trim()
  if (!/^\d{5}$/.test(z)) return null
  const c = ZCTA[z]
  if (!c) return null
  let best: { row: Row; miles: number } | null = null
  for (const row of Object.values(PLACES)) {
    const miles = haversineDistance(c[0], c[1], row[1], row[2])
    if (!best || miles < best.miles) best = { row, miles }
  }
  return best && best.miles <= 25 ? { name: best.row[0], lat: c[0], lng: c[1] } : null
}

/**
 * Places matching typed input: "Ames, IA" exactly; "Ames" in every state that
 * has one (sorted, so an ambiguous name always lists the same way); a ZIP.
 * A stated state is a constraint, never a hint. Empty when nothing matches.
 */
export function findPlaces(input: string, limit = 12): Place[] {
  const zip = placeForZip(input)
  if (zip) return [zip]
  const k = key(input)
  if (!k) return []
  const exact = PLACES[k]
  if (exact) return [toPlace(exact)]
  const [city, state] = [k.split(', ')[0], k.split(', ')[1]]
  if (state) return [] // "Ames, NE": no such place; never another state's Ames
  return (cityIndex().get(city) ?? []).sort().slice(0, limit).map(k2 => toPlace(PLACES[k2]))
}

/** As-you-type suggestions: places whose name starts with the input (optionally "…, ST"). */
export function suggestPlaces(input: string, limit = 8): Place[] {
  const k = key(input)
  if (k.length < 3) return []
  const [cityPart, statePart] = [k.split(',')[0].trim(), k.split(',')[1]?.trim()]
  const out: Place[] = []
  for (const [city, keys] of cityIndex()) {
    if (!city.startsWith(cityPart)) continue
    for (const k2 of keys) {
      if (statePart && !k2.endsWith(`, ${statePart}`) && !k2.split(', ')[1].startsWith(statePart)) continue
      out.push(toPlace(PLACES[k2]))
    }
  }
  // Exact city names first, then shorter names, then alphabetical.
  return out
    .sort((a, b) => {
      const ea = key(a.name).startsWith(`${cityPart},`) ? 0 : 1, eb = key(b.name).startsWith(`${cityPart},`) ? 0 : 1
      return ea - eb || a.name.length - b.name.length || a.name.localeCompare(b.name)
    })
    .slice(0, limit)
}

/** The place a market string names, if any ("Ames, IA", or "Ames" + state "IA"). */
export function placeCoords(market: string, state?: string | null): Place | null {
  const m = key(market)
  if (!m) return null
  const withState = state && !m.endsWith(`, ${state.toLowerCase()}`) ? `${m}, ${state.toLowerCase()}` : m
  const hit = PLACES[withState] ?? PLACES[m]
  return hit ? toPlace(hit) : placeForZip(market)
}

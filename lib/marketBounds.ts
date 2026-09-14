/**
 * Market coordinates sourced from the list the team actually maintains.
 *
 * dbo.standard_market_lookup is the canonical market list — every scheduled
 * shift requires selecting one, and client_program_markets carries the chosen
 * standard_market_uid. In environments where the LED schema includes bounding
 * boxes, that table also carries the geography, so a job's coordinates can come
 * from the job itself rather than being guessed from its market NAME against a
 * hardcoded file.
 *
 * Why the capability check
 * -----------------------
 * Those bounds columns are part of an LED-product migration that reaches
 * environments at different times. Referencing a column SQL Server does not
 * have is a hard error, not a null — so a query written for the new schema
 * takes down availability everywhere the migration has not landed. UAT had the
 * columns while production did not, which is exactly the shape of bug that
 * passes every test and breaks on promotion.
 *
 * So capability is detected once per process and the appropriate query is used.
 * When the migration is everywhere this can collapse to a single query and the
 * check can be deleted.
 */

import { query } from '@/lib/mssql'

const BOUNDS_COLUMNS = ['bounds_ne_lat', 'bounds_ne_lng', 'bounds_sw_lat', 'bounds_sw_lng']

let cached: boolean | null = null

/**
 * Does this database's standard_market_lookup carry bounding boxes?
 * Result is cached for the life of the process; a failed check reports false,
 * so the app degrades to name lookup rather than erroring.
 */
export async function hasMarketBounds(): Promise<boolean> {
  if (cached !== null) return cached
  try {
    const rows = await query<{ COLUMN_NAME: string }[]>(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'standard_market_lookup'
        AND COLUMN_NAME IN ('bounds_ne_lat','bounds_ne_lng','bounds_sw_lat','bounds_sw_lng')
    `)
    const found = new Set(rows.map(r => r.COLUMN_NAME))
    cached = BOUNDS_COLUMNS.every(c => found.has(c))
    if (!cached) {
      console.warn(
        `[marketBounds] standard_market_lookup has no bounding boxes here `
        + `(found ${found.size}/4) — job coordinates fall back to the name map.`,
      )
    }
  } catch (err) {
    console.error('[marketBounds] capability check failed, assuming absent:', err)
    cached = false
  }
  return cached
}

/** Test seam — forget the cached capability. */
export function resetMarketBoundsCache(): void {
  cached = null
}

/**
 * The centroid select list, when bounds are available.
 * NULL bounds yield NULL coordinates, which callers treat as "not resolved"
 * and fall back exactly as if the columns were absent.
 */
export const MARKET_CENTROID_SELECT = `
    CASE WHEN sml.bounds_ne_lat IS NOT NULL AND sml.bounds_sw_lat IS NOT NULL
         THEN (sml.bounds_ne_lat + sml.bounds_sw_lat) / 2.0 END AS market_lat,
    CASE WHEN sml.bounds_ne_lng IS NOT NULL AND sml.bounds_sw_lng IS NOT NULL
         THEN (sml.bounds_ne_lng + sml.bounds_sw_lng) / 2.0 END AS market_lng`

export const MARKET_CENTROID_JOIN = `
LEFT JOIN dbo.standard_market_lookup sml
    ON  sml.standard_market_uid = cpm.standard_market_uid`

// ---------------------------------------------------------------------------
// Name-keyed lookup, for records that carry no standard_market_uid
// ---------------------------------------------------------------------------

export type MarketCoords = { lat: number; lng: number }

/**
 * Normalize a market name for comparison.
 * standard_market values carry stray leading spaces (" Boston, MA"), and hold
 * markets are free text, so both sides are squashed to the same shape.
 */
export function normalizeMarketKey(name: string): string {
  return (name || '')
    .trim()
    .toLowerCase()
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
}

let marketCoordsCache: Map<string, MarketCoords> | null = null

/**
 * Every standard market's centroid, keyed by normalized name.
 *
 * Holds and typed campaign markets have no standard_market_uid to join on, so
 * they are matched by name instead — but against the authoritative 356-market
 * list rather than the 281-entry hardcoded file, which covers 61% of it.
 *
 * Loaded once per process (356 rows), and empty when the bounds columns are
 * absent so callers fall through to their existing behavior.
 */
export async function loadStandardMarketCoords(): Promise<Map<string, MarketCoords>> {
  if (marketCoordsCache) return marketCoordsCache
  if (!(await hasMarketBounds())) {
    marketCoordsCache = new Map()
    return marketCoordsCache
  }
  try {
    const rows = await query<{ standard_market: string; lat: number; lng: number }[]>(`
      SELECT standard_market,
             (bounds_ne_lat + bounds_sw_lat) / 2.0 AS lat,
             (bounds_ne_lng + bounds_sw_lng) / 2.0 AS lng
      FROM dbo.standard_market_lookup
      WHERE bounds_ne_lat IS NOT NULL AND bounds_sw_lat IS NOT NULL
        AND bounds_ne_lng IS NOT NULL AND bounds_sw_lng IS NOT NULL
    `)
    const map = new Map<string, MarketCoords>()
    for (const r of rows) {
      const key = normalizeMarketKey(r.standard_market)
      if (!key) continue
      const lat = Number(r.lat)
      const lng = Number(r.lng)
      if (Number.isFinite(lat) && Number.isFinite(lng)) map.set(key, { lat, lng })
    }
    marketCoordsCache = map
  } catch (err) {
    console.error('[marketBounds] standard market coord load failed:', err)
    marketCoordsCache = new Map()
  }
  return marketCoordsCache
}

/** Test seam — forget the cached market coordinates. */
export function resetStandardMarketCoordsCache(): void {
  marketCoordsCache = null
}

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


/**
 * The canonical standard-market name for a free-text market, or null.
 *
 * Holds are written from several paths with whatever market text the caller
 * had, so the same place ends up stored as "Dallas", "dallas, tx" and
 * "Dallas, TX". Those strings are what later resolve a hold's coordinates —
 * there is no standard_market_uid on a hold — so canonicalizing on write is
 * what keeps a hold usable as a transport origin later.
 *
 * Returns null when nothing matches; callers keep the caller's text rather than
 * rejecting, so an unrecognized market never blocks a booking.
 */
export async function canonicalMarketName(market: string, state?: string): Promise<string | null> {
  const raw = (market || '').trim()
  if (!raw) return null

  let coords: Map<string, MarketCoords>
  try {
    coords = await loadStandardMarketCoords()
  } catch {
    return null
  }
  if (coords.size === 0) return null

  const matched = matchMarketKey(raw, state, coords.keys())
  return matched ? titleCaseMarket(matched) : null
}

/**
 * Match free-text market input against a set of canonical keys.
 *
 * Pure and separated from the database so the rule itself is testable:
 *   1. "market, state" when the state is not already on the end
 *   2. the market as written
 *   3. city-only, but ONLY when exactly one market has that city — "Portland"
 *      matching both OR and ME is an ambiguity, not a result.
 *
 * An explicitly supplied state is a CONSTRAINT, not a hint. "Dallas, GA" must
 * not fall back to "Dallas, TX" just because Texas is the only Dallas we know —
 * that would silently relocate a campaign a thousand miles.
 */
export function matchMarketKey(
  market: string,
  state: string | undefined,
  keys: Iterable<string>,
): string | null {
  const key = normalizeMarketKey(market)
  if (!key) return null

  const keyList = [...keys]
  const known = new Set(keyList)

  const withState =
    state && !key.endsWith(`, ${state.trim().toLowerCase()}`)
      ? normalizeMarketKey(`${market}, ${state}`)
      : key

  for (const candidate of [withState, key]) {
    if (known.has(candidate)) return candidate
  }

  const city = key.split(',')[0].trim()
  if (!city) return null

  // Whatever state the caller actually stated, from either source.
  const statedState = (key.split(',')[1]?.trim() || state?.trim().toLowerCase() || '')

  const cityHits = keyList.filter(k => k.split(',')[0].trim() === city)

  if (statedState) {
    // A stated state narrows; it never broadens. No match in that state is a
    // non-match, not an invitation to pick a different one.
    const inState = cityHits.filter(k => k.split(',')[1]?.trim() === statedState)
    return inState.length === 1 ? inState[0] : null
  }

  return cityHits.length === 1 ? cityHits[0] : null
}

/** Title-case a "city, st" key for display: "allentown, pa" -> "Allentown, PA". */
export function titleCaseMarket(key: string): string {
  const [city, st] = key.split(',').map(p => p.trim())
  const titled = city.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  return st ? `${titled}, ${st.toUpperCase()}` : titled
}

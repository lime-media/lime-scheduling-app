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

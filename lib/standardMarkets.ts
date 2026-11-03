/**
 * LED's standard market for a hold's free-text market.
 *
 * dbo.standard_market_lookup is the one market list: LED programs and
 * CampaignIQ requests carry a standard_market_uid. A hold carries only market
 * text, so the sweep sets app_holds.standard_market_uid from it:
 *   1. the standard market of that name ("Dallas, TX"), by the same rule as
 *      canonicalMarketName (lib/marketBounds.ts matchMarketKey);
 *   2. else the town's location (lib/geo/places.ts) inside a standard market's
 *      area; where areas overlap, the one whose centre is nearest;
 *   3. else none. A Salesforce "Multi-market: ..." label names several markets
 *      and stays unset.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { query } from '@/lib/mssql'
import { hasMarketBounds, matchMarketKey, normalizeMarketKey } from '@/lib/marketBounds'
import { placeCoords } from '@/lib/geo/places'

export type StandardMarket = {
  uid: string
  key: string
  /** Bounding box; null where this database's lookup has none. */
  box: { ne_lat: number; ne_lng: number; sw_lat: number; sw_lng: number } | null
}

export type StandardMarketMatch = { uid: string; via: 'name' | 'area' }

const inBox = (b: NonNullable<StandardMarket['box']>, lat: number, lng: number) =>
  lat >= b.sw_lat && lat <= b.ne_lat && lng >= b.sw_lng && lng <= b.ne_lng

/** Pure: the standard market for market text, given the list and the place lookup. */
export function pickStandardMarket(
  market: string,
  state: string | undefined,
  markets: readonly StandardMarket[],
  locate: (market: string, state?: string) => { lat: number; lng: number } | null = placeCoords,
): StandardMarketMatch | null {
  if (!normalizeMarketKey(market)) return null
  const byKey = new Map(markets.map(m => [m.key, m]))
  const named = matchMarketKey(market, state, byKey.keys())
  if (named) return { uid: byKey.get(named)!.uid, via: 'name' }

  const at = locate(market, state)
  if (!at) return null
  let best: { uid: string; d: number } | null = null
  for (const m of markets) {
    if (!m.box || !inBox(m.box, at.lat, at.lng)) continue
    const dLat = (m.box.ne_lat + m.box.sw_lat) / 2 - at.lat
    const dLng = ((m.box.ne_lng + m.box.sw_lng) / 2 - at.lng) * Math.cos(at.lat * Math.PI / 180)
    const d = dLat * dLat + dLng * dLng
    if (!best || d < best.d) best = { uid: m.uid, d }
  }
  return best ? { uid: best.uid, via: 'area' } : null
}

const warned = new Set<string>()
/** Logs once per process, not every sweep: a bad row stays bad until LED fixes it. */
const warnOnce = (key: string, message: string) => {
  if (!warned.has(key)) console.warn(`[standardMarkets] ${message}`)
  warned.add(key)
}

/** Every standard market. Throws on a failed read, so the caller keeps what it has. */
export async function loadStandardMarkets(): Promise<StandardMarket[]> {
  const bounds = await hasMarketBounds()
  const rows = await query<{ uid: string; name: string; ne_lat?: number; ne_lng?: number; sw_lat?: number; sw_lng?: number }[]>(`
    SELECT CAST(standard_market_uid AS NVARCHAR(36)) AS uid, standard_market AS name
      ${bounds ? ', bounds_ne_lat AS ne_lat, bounds_ne_lng AS ne_lng, bounds_sw_lat AS sw_lat, bounds_sw_lng AS sw_lng' : ''}
    FROM dbo.standard_market_lookup
    ORDER BY standard_market_id
  `)
  const out: StandardMarket[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const key = normalizeMarketKey(r.name)
    if (!key || !r.uid) continue
    // Two rows of one name: the older row wins, the same one every sweep.
    if (seen.has(key)) {
      warnOnce(`dup:${key}`, `"${r.name.trim()}" is listed twice; holds get the first row`)
      continue
    }
    seen.add(key)
    const raw = [r.ne_lat, r.ne_lng, r.sw_lat, r.sw_lng]
    const nums = raw.map(Number)
    const box = bounds && raw.every(v => v != null) && nums.every(Number.isFinite)
      ? { ne_lat: nums[0], ne_lng: nums[1], sw_lat: nums[2], sw_lng: nums[3] }
      : null
    const market: StandardMarket = { uid: r.uid.toUpperCase(), key, box }
    if (box && !boxIsWhereItsCityIs(market)) {
      warnOnce(`box:${key}`, `"${r.name.trim()}": its area isn't where the town is; matched by name only`)
      market.box = null
    }
    out.push(market)
  }
  return out
}

/** Miles between two points (equirectangular; ample at this scale). */
const milesApart = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const dLat = a.lat - b.lat
  const dLng = (a.lng - b.lng) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLng * dLng) * 69
}

/**
 * Pure: whether a market's area sits on its own city. Some rows carry a
 * placeholder or another town's box (e.g. a box in central Kansas for a city
 * elsewhere); matching towns by such a box would file them under a market
 * hundreds of miles away. A market whose city isn't in the place list can't be
 * checked and is trusted.
 */
export function boxIsWhereItsCityIs(
  m: StandardMarket,
  locate: (market: string) => { lat: number; lng: number } | null = placeCoords,
  maxMiles = 60,
): boolean {
  if (!m.box) return true
  const city = locate(m.key)
  if (!city) return true
  const centre = { lat: (m.box.ne_lat + m.box.sw_lat) / 2, lng: (m.box.ne_lng + m.box.sw_lng) / 2 }
  return milesApart(city, centre) <= maxMiles
}

const IN_CHUNK = 900

/** A two-letter state, or undefined: holds carry "", "Multi" and the like. */
const usState = (s: string | null | undefined) => (s && /^[A-Za-z]{2}$/.test(s.trim()) ? s.trim() : undefined)

/**
 * Sets standard_market_uid on every hold not yet EXPIRED, from its market
 * text, wherever it differs (an edited market moves it; one no longer located
 * clears it). Never throws: a failed read changes nothing, and a failed write
 * is logged and the rest carry on. The result says which: `failed` counts the
 * holds a write didn't reach, and `error` names a read that failed, so a
 * sweep reporting 0 set means converged only when both are clear.
 *
 * Written with plain SQL so a hold's updated_at keeps meaning a change to the
 * booking (Prisma's updateMany would stamp it).
 */
export type StandardMarketAssignment = { updated: number; failed: number; unlocated: number; error: string | null }

export async function assignStandardMarkets(): Promise<StandardMarketAssignment> {
  const none = (error: string | null): StandardMarketAssignment => ({ updated: 0, failed: 0, unlocated: 0, error })
  let markets: StandardMarket[]
  try {
    markets = await loadStandardMarkets()
  } catch (err) {
    console.error('[standardMarkets] standard market list read failed; holds left as they are:', err)
    return none('standard market list read failed')
  }
  if (markets.length === 0) return none('standard market list is empty')

  // Without any area (the bounds check failed or the columns are absent), a
  // town can't be placed: leave such holds as they are rather than clear them.
  const areasKnown = markets.some(m => m.box)

  let holds: { id: string; market: string; state: string; standard_market_uid: string | null }[]
  try {
    holds = await prisma.hold.findMany({
      where: { status: { not: 'EXPIRED' } },
      select: { id: true, market: true, state: true, standard_market_uid: true },
    })
  } catch (err) {
    console.error('[standardMarkets] hold read failed; holds left as they are:', err)
    return none('hold read failed')
  }
  const memo = new Map<string, string | null>()
  const changes = new Map<string | null, string[]>()
  let unlocated = 0
  for (const h of holds) {
    const memoKey = `${h.market}\u0000${h.state}`
    if (!memo.has(memoKey)) memo.set(memoKey, pickStandardMarket(h.market, usState(h.state), markets)?.uid ?? null)
    const uid = memo.get(memoKey)!
    if (!uid) unlocated++
    if ((h.standard_market_uid?.toUpperCase() ?? null) === uid) continue
    if (!uid && !areasKnown) continue
    changes.set(uid, [...(changes.get(uid) ?? []), h.id])
  }

  let updated = 0
  let failed = 0
  for (const [uid, ids] of changes) {
    // Under SQL Server's 2,100-parameter limit per statement.
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const slice = ids.slice(i, i + IN_CHUNK)
      try {
        updated += await prisma.$executeRaw`UPDATE dbo.app_holds SET standard_market_uid = ${uid} WHERE id IN (${Prisma.join(slice)})`
      } catch (err) {
        failed += slice.length
        console.error(`[standardMarkets] setting ${slice.length} holds to ${uid ?? 'none'} failed; retried next sweep:`, err)
      }
    }
  }
  return { updated, failed, unlocated, error: null }
}

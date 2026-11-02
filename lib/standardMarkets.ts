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

/** Every standard market (363 rows). Throws on a failed read, so the caller keeps what it has. */
export async function loadStandardMarkets(): Promise<StandardMarket[]> {
  const bounds = await hasMarketBounds()
  const rows = await query<{ uid: string; name: string; ne_lat?: number; ne_lng?: number; sw_lat?: number; sw_lng?: number }[]>(`
    SELECT CAST(standard_market_uid AS NVARCHAR(36)) AS uid, standard_market AS name
      ${bounds ? ', bounds_ne_lat AS ne_lat, bounds_ne_lng AS ne_lng, bounds_sw_lat AS sw_lat, bounds_sw_lng AS sw_lng' : ''}
    FROM dbo.standard_market_lookup
  `)
  const out: StandardMarket[] = []
  for (const r of rows) {
    const key = normalizeMarketKey(r.name)
    if (!key || !r.uid) continue
    const raw = [r.ne_lat, r.ne_lng, r.sw_lat, r.sw_lng]
    const nums = raw.map(Number)
    const box = bounds && raw.every(v => v != null) && nums.every(Number.isFinite)
      ? { ne_lat: nums[0], ne_lng: nums[1], sw_lat: nums[2], sw_lng: nums[3] }
      : null
    const market: StandardMarket = { uid: r.uid.toUpperCase(), key, box }
    if (box && !boxIsWhereItsCityIs(market)) {
      console.warn(`[standardMarkets] "${r.name.trim()}": its area isn't where the town is; matched by name only`)
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
 * clears it). Never throws: a failed read of the list changes nothing.
 */
export async function assignStandardMarkets(): Promise<{ updated: number; unlocated: number }> {
  let markets: StandardMarket[]
  try {
    markets = await loadStandardMarkets()
  } catch (err) {
    console.error('[standardMarkets] standard market list read failed; holds left as they are:', err)
    return { updated: 0, unlocated: 0 }
  }
  if (markets.length === 0) return { updated: 0, unlocated: 0 }

  const holds = await prisma.hold.findMany({
    where: { status: { not: 'EXPIRED' } },
    select: { id: true, market: true, state: true, standard_market_uid: true },
  })
  const memo = new Map<string, string | null>()
  const changes = new Map<string | null, string[]>()
  let unlocated = 0
  for (const h of holds) {
    const memoKey = `${h.market}\u0000${h.state}`
    if (!memo.has(memoKey)) memo.set(memoKey, pickStandardMarket(h.market, usState(h.state), markets)?.uid ?? null)
    const uid = memo.get(memoKey)!
    if (!uid) unlocated++
    if ((h.standard_market_uid?.toUpperCase() ?? null) === uid) continue
    changes.set(uid, [...(changes.get(uid) ?? []), h.id])
  }

  let updated = 0
  for (const [uid, ids] of changes) {
    // Under SQL Server's 2,100-parameter limit per statement.
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const res = await prisma.hold.updateMany({ where: { id: { in: ids.slice(i, i + IN_CHUNK) } }, data: { standard_market_uid: uid } })
      updated += res.count
    }
  }
  return { updated, unlocated }
}

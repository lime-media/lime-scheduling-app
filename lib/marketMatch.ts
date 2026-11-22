/**
 * The one way market text becomes an entry on the market list.
 *
 * dbo.standard_market_lookup is the one published market list, shared with
 * the LED app: LED programs and campaign requests carry its
 * standard_market_uid. Every path that takes market text (quotes, bookings,
 * the LED filing sweep, the AI chat, the MCP) matches it here, so the same
 * text lands on the same entry everywhere. Matching never adds to the list:
 * text that matches nothing stays unmatched until LED adds the market.
 *
 * Like the LED app, a match is either obvious or not (Andrew, 2026-11-16):
 *   - obvious: the field defaults to `choice`, and the person can change it;
 *   - not obvious: they pick from `candidates`.
 * Obvious: the list's own name; a state written another way ("Dallas, Tex",
 * "Kansas City, MO-KS"); a city the list has once; a town inside exactly one
 * market's area. Not obvious: a city the list has in several states
 * ("Springfield"), region or county text after the comma ("Allentown, Lehigh
 * Valley", "Aurora, Kane Co"), a town inside overlapping areas, or nothing
 * (the nearest markets are offered).
 */

import { normalizeMarketKey } from '@/lib/marketBounds'
import { placeCoords, withStateComma } from '@/lib/geo/places'
import { loadStandardMarkets, type StandardMarket } from '@/lib/standardMarkets'
import { mayBeState, stateCode, stateFromText } from '@/lib/usStates'

export type MarketChoice = { uid: string; name: string }

export type MarketMatch = {
  /** The entry to default to; null when nothing is obvious. */
  choice: MarketChoice | null
  obvious: boolean
  /** What to pick from: the choice first when there is one, else the likeliest entries. */
  candidates: MarketChoice[]
  /** How it was found. 'nearest' offers the closest markets to an unmatched town. */
  via: 'name' | 'city' | 'area' | 'nearest' | 'none'
}

/** Market text read as a city and state. `qualifier`: text after the comma that names no state. */
export type MarketText = { city: string; state?: string; qualifier?: 'region' | 'unknown_state' }

const COUNTY = /^(county|co|cnty|parish)$/i

/**
 * Market text as a city and a state code (lower case). The state is the text
 * after the comma written any common way (lib/usStates.ts stateFromText): a
 * code, a full name, an abbreviation ("Tex") or a metro's first state
 * ("MO-KS"); a ZIP or ", USA" may follow it. A state named later in the text
 * counts ("Allentown, Lehigh Valley PA"), but a two-letter word only when it's
 * written in capitals and isn't "Co" (County): "Aurora, Kane Co" names no
 * state. Other text is a region; text that could be a misspelled state
 * ("Dallas, Pensylvania") is an unknown state. Pure.
 */
export function readMarketText(raw: string): MarketText {
  const t = withStateComma((raw || '').trim()).replace(/\./g, '')
  const comma = t.indexOf(',')
  const city = normalizeMarketKey(comma < 0 ? t : t.slice(0, comma))
  if (comma < 0) return { city }
  const rest = t.slice(comma + 1).trim()
  const head = rest.replace(/\s*,?\s*\d[\d-]*$/, '').replace(/,\s*(usa?|united states( of america)?)$/i, '').trim()
  if (!head || /^(usa?|united states( of america)?|america)$/i.test(head)) return { city }
  const words = head.split(/\s+/)
  const lower = (c: string) => ({ city, state: c.toLowerCase() })
  // The whole text after the comma is a state, any case ("tex", "co", "MO-KS").
  const whole = stateFromText(head)
  if (whole) return lower(whole)
  // County text: the words up to the county word name the county, never a
  // state ("Delaware County" isn't Delaware); a state may follow it
  // ("Media, Delaware County PA").
  const ci = words.findIndex(w => COUNTY.test(w))
  if (ci >= 0) {
    const s = statedIn(words.slice(ci + 1))
    return s ? lower(s) : { city, qualifier: 'region' }
  }
  const s = statedIn(words)
  if (s) return lower(s)
  // An abbreviation first, then only an area word ("Tex area"); never the
  // start of a place name ("Del Mar", "Mont Belvieu"). A two-letter one only
  // in capitals ("La Jolla" isn't Louisiana).
  if (words.slice(1).every(w => AREA.test(w)) && (words[0].length > 2 || /^[A-Z]{2}$/.test(words[0])) && stateFromText(words[0])) {
    return lower(stateFromText(words[0]))
  }
  return { city, qualifier: mayBeState(words[0]) ? 'unknown_state' : 'region' }
}

const AREA = /^(area|metro|metropolitan|region|market)$/i

/**
 * A state the words name: a trailing two-letter code in capitals ("Lehigh
 * Valley PA"; not "Co"), else a full state name among them, longest first
 * ("North Texas", "New York"). Abbreviations don't count here. '' when none.
 */
function statedIn(words: string[]): string {
  const last = words[words.length - 1]
  if (last && /^[A-Z]{2}$/.test(last) && !COUNTY.test(last) && stateCode(last)) return stateCode(last)
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const part = words.slice(i, i + n).join(' ')
      const code = n > 1 || part.length > 2 ? stateCode(part) : ''
      if (code) return code
    }
  }
  return ''
}

type Entry = { m: StandardMarket; city: string; state?: string; choice: MarketChoice }

const titled = (key: string) => key.replace(/\b\w/g, c => c.toUpperCase()).replace(/, (\w\w)$/, (_, s: string) => `, ${s.toUpperCase()}`)

// Read once per list, not per match: the sweep matches every hold.
const read = new WeakMap<readonly StandardMarket[], Entry[]>()
function entries(list: readonly StandardMarket[]): Entry[] {
  const have = read.get(list)
  if (have) return have
  const out = list.map(m => {
    const r = readMarketText(m.name ?? m.key)
    return { m, city: r.city, state: r.state, choice: { uid: m.uid, name: m.name ?? titled(m.key) } }
  })
  read.set(list, out)
  return out
}

const centre = (b: NonNullable<StandardMarket['box']>) => ({ lat: (b.ne_lat + b.sw_lat) / 2, lng: (b.ne_lng + b.sw_lng) / 2 })
const inBox = (b: NonNullable<StandardMarket['box']>, p: { lat: number; lng: number }) =>
  p.lat >= b.sw_lat && p.lat <= b.ne_lat && p.lng >= b.sw_lng && p.lng <= b.ne_lng
const dist2 = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const dLng = (a.lng - b.lng) * Math.cos(a.lat * Math.PI / 180)
  return (a.lat - b.lat) ** 2 + dLng * dLng
}

/** How many nearest markets an unmatched town is offered. */
export const NEAREST_OFFERED = 5

const byName = (a: Entry, b: Entry) => a.choice.name.localeCompare(b.choice.name)
const pick = (hits: Entry[], via: MarketMatch['via']): MarketMatch => ({ choice: hits[0].choice, obvious: true, candidates: [hits[0].choice], via })
const offer = (hits: Entry[], via: MarketMatch['via']): MarketMatch => ({ choice: null, obvious: false, candidates: hits.map(h => h.choice), via })

/**
 * Market text (and the state a form gave separately, if any) against the
 * list. Pure: the list and the place lookup are passed in.
 */
export function matchMarket(
  raw: string,
  state: string | undefined,
  list: readonly StandardMarket[],
  locate: (market: string, state?: string) => { lat: number; lng: number } | null = placeCoords,
): MarketMatch {
  const none: MarketMatch = { choice: null, obvious: false, candidates: [], via: 'none' }
  const text = (raw || '').trim()
  if (!normalizeMarketKey(text)) return none
  const all = entries(list)
  const given = stateCode(state ?? '').toLowerCase() || undefined

  // The list's own name, as typed, with its state comma'd, or with the form's state.
  const keys = new Set([normalizeMarketKey(text), normalizeMarketKey(withStateComma(text))])
  if (given) keys.add(normalizeMarketKey(`${text}, ${given}`))
  const exact = all.filter(e => keys.has(e.m.key))
  if (exact.length === 1) return pick(exact, 'name')

  const parsed = readMarketText(text)
  // A region keeps the form's state (it narrows what's offered and places the
  // town); text that may be a misspelled state doesn't trust it.
  const st = parsed.state ?? (parsed.qualifier === 'unknown_state' ? undefined : given)
  const sameCity = all.filter(e => e.city === parsed.city).sort(byName)
  if (parsed.qualifier) {
    // Region or unreadable state: never obvious. Its city's entries to pick
    // from, in the form's state when it has any there.
    const inState = st ? sameCity.filter(e => e.state === st) : []
    const offered = inState.length ? inState : sameCity
    if (offered.length) return offer(offered, 'city')
  } else if (st) {
    // A stated state narrows; it never broadens to another state's city.
    const inState = sameCity.filter(e => e.state === st)
    if (inState.length === 1) return pick(inState, 'city')
    if (inState.length > 1) return offer(inState, 'city')
  } else if (sameCity.length === 1) {
    return pick(sameCity, 'city')
  } else if (sameCity.length > 1) {
    return offer(sameCity, 'city')
  }

  // Not on the list by name: the town's place, inside a market's area.
  const at = locate(text, st)
    ?? (parsed.city && st ? locate(parsed.city, st) : null)
  if (!at) return none
  const boxed = all.filter(e => e.m.box && inBox(e.m.box, at)).sort((a, b) => dist2(at, centre(a.m.box!)) - dist2(at, centre(b.m.box!)))
  if (boxed.length === 1 && !parsed.qualifier) return pick(boxed, 'area')
  if (boxed.length) return offer(boxed, 'area')
  const nearest = all.filter(e => e.m.box).sort((a, b) => dist2(at, centre(a.m.box!)) - dist2(at, centre(b.m.box!))).slice(0, NEAREST_OFFERED)
  return nearest.length ? offer(nearest, 'nearest') : none
}

/**
 * The entry a path with no person to ask files under (the LED filing sweep):
 * the obvious choice, else the nearest market whose area holds the town, as
 * the sweep has always filed it. Never a name guess between states, and never
 * merely the nearest market to a town outside every area. Pure.
 */
export function unattendedChoice(m: MarketMatch): MarketChoice | null {
  return m.choice ?? (m.via === 'area' ? m.candidates[0] ?? null : null)
}

// ── The list, shared and refreshed ───────────────────────────────────────────

/** How long the list is reused before it's read again, so an entry LED adds is used within minutes. */
export const LIST_REFRESH_MS = 10 * 60 * 1000

/** How soon a list read with no market areas is read again (the bounds check may have failed). */
export const NO_AREAS_RETRY_MS = 60 * 1000

type ListState = { cached: { at: number; list: StandardMarket[] } | null; loading: Promise<StandardMarket[]> | null }
const state: ListState = { cached: null, loading: null }

const hasAreas = (list: readonly StandardMarket[]) => list.some(m => m.box)

/**
 * The market list, read at most every LIST_REFRESH_MS. Once there is a list,
 * a stale one is returned at once and re-read in the background, so a slow or
 * unreachable database never holds up matching. A failed read, or one that
 * comes back with no market areas when the last one had them, keeps the last
 * good list. A list with no areas is read again within a minute. Only the
 * first read is waited on (and throws if it fails).
 */
export function marketListWith(load: () => Promise<StandardMarket[]>, s: ListState, now = Date.now()): Promise<StandardMarket[]> {
  const fresh = s.cached && now - s.cached.at < (hasAreas(s.cached.list) ? LIST_REFRESH_MS : NO_AREAS_RETRY_MS)
  if (s.cached && fresh) return Promise.resolve(s.cached.list)
  if (!s.loading) {
    s.loading = load()
      .then(list => {
        if (s.cached && hasAreas(s.cached.list) && !hasAreas(list)) {
          console.error('[marketMatch] the market list came back with no areas; keeping the last one')
          s.cached = { at: Date.now(), list: s.cached.list }
        } else {
          s.cached = { at: Date.now(), list }
        }
        return s.cached.list
      })
      .catch(err => {
        if (!s.cached) throw err
        console.error('[marketMatch] market list read failed; using the last one:', err)
        s.cached = { at: Date.now(), list: s.cached.list }
        return s.cached.list
      })
      .finally(() => { s.loading = null })
  }
  if (s.cached) {
    s.loading.catch(() => { /* reported above; the cached list stands */ })
    return Promise.resolve(s.cached.list)
  }
  return s.loading
}

/** The shared market list (marketListWith over the database). */
export function marketList(): Promise<StandardMarket[]> {
  return marketListWith(loadStandardMarkets, state)
}

/** Market text against the current list. Throws only when the list has never been read. */
export async function matchMarketText(raw: string, state?: string): Promise<MarketMatch> {
  return matchMarket(raw, state, await marketList())
}

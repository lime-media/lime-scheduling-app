/**
 * Client ZIP list -> coverage areas.
 *
 * Clients send their footprint as a list of ZIPs grouped under DMA names, and
 * the list is rarely clean: duplicate ZIPs, rows with no DMA, PO-box ZIPs with
 * no households, typos that land a ZIP in another state, and several DMA names
 * that are really one place a single truck can work. This module turns that
 * list into the areas a truck is assigned to, and reports every correction it
 * made instead of silently absorbing it — the flags are what a rep takes back
 * to the client.
 *
 * Pure: the ZIP centroids and market coordinates are passed in.
 */

import { haversineDistance } from '@/lib/marketCoordinates'

export type ZipRow = { label: string; zip: string; city: string; state: string }

export type AreaFlagKind =
  | 'DUPLICATE'      // the same ZIP listed more than once
  | 'NO_LABEL'       // a row with no DMA name; placed with the nearest area
  | 'NOT_GEOCODED'   // not a Census ZCTA — almost always a PO-box or unique ZIP with no households
  | 'OUTLIER'        // geocodes far from the rest of its DMA — usually a typo
  | 'OUTSIDE_48'     // outside the contiguous 48 states, which we do not serve
  | 'INVALID_ZIP'    // not a ZIP at all

export type AreaFlag = { kind: AreaFlagKind; zip?: string; label?: string; detail: string }

export type Area = {
  id: string
  name: string
  /** The client's DMA names that make up this area. */
  labels: string[]
  zips: string[]
  /** ZIPs that geocode, i.e. that have households to reach. */
  residentialZips: number
  lat: number
  lng: number
  /** Furthest geocoded ZIP from the area's centre, in straight-line miles. */
  spreadMiles: number
  nearestMarket: { name: string; distanceMiles: number } | null
}

export type AreaBuildResult = {
  rows: number
  uniqueZips: number
  areas: Area[]
  flags: AreaFlag[]
}

export type Centroids = Record<string, [number, number]>

// Contiguous 48 bounding box — generous at the edges, excludes AK, HI, PR.
function inContiguous48(lat: number, lng: number): boolean {
  return lat >= 24.3 && lat <= 49.5 && lng >= -125.0 && lng <= -66.8
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function splitLine(line: string, delim: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++ } else quoted = !quoted
    } else if (ch === delim && !quoted) {
      out.push(cur); cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map(s => s.trim())
}

const LABEL_HEADERS = ['dma name', 'dma', 'market', 'area', 'region name', 'label']
const ZIP_HEADERS = ['zip', 'zip code', 'zipcode', 'postal code', 'zip5']

/**
 * Parse pasted CSV / TSV text. Accepts a header row naming the DMA and ZIP
 * columns in any order; without one, assumes DMA, ZIP, City, State. Title rows
 * and blank lines above the header are skipped. Spreadsheet exports drop
 * leading zeros, so 3- and 4-digit ZIPs are padded back to 5.
 */
export function parseZipRows(text: string): { rows: ZipRow[]; flags: AreaFlag[] } {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
  const flags: AreaFlag[] = []
  if (lines.length === 0) return { rows: [], flags }
  const delim = lines.some(l => l.includes('\t')) ? '\t' : ','

  let col = { label: 0, zip: 1, city: 2, state: 3 }
  let start = 0
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const cells = splitLine(lines[i], delim).map(c => c.toLowerCase())
    const zipIdx = cells.findIndex(c => ZIP_HEADERS.includes(c))
    if (zipIdx >= 0) {
      const labelIdx = cells.findIndex(c => LABEL_HEADERS.includes(c))
      col = {
        label: labelIdx,
        zip: zipIdx,
        city: cells.findIndex(c => c === 'city'),
        state: cells.findIndex(c => c === 'state' || c === 'st'),
      }
      start = i + 1
      break
    }
  }

  const rows: ZipRow[] = []
  for (const line of lines.slice(start)) {
    const cells = splitLine(line, delim)
    const rawZip = (cells[col.zip] ?? '').replace(/\.0$/, '').trim()
    if (!rawZip) continue
    // A repeated header (one per sheet when sheets are pasted together).
    if (ZIP_HEADERS.includes(rawZip.toLowerCase())) continue
    const digits = rawZip.split('-')[0]
    if (!/^\d{3,5}$/.test(digits)) {
      flags.push({ kind: 'INVALID_ZIP', zip: rawZip, detail: `"${rawZip}" is not a ZIP code` })
      continue
    }
    const label = col.label >= 0 ? (cells[col.label] ?? '').trim() : ''
    rows.push({
      label: /^(none|null|n\/a|-)?$/i.test(label) ? '' : label,
      zip: digits.padStart(5, '0'),
      city: col.city >= 0 ? (cells[col.city] ?? '').trim() : '',
      state: col.state >= 0 ? (cells[col.state] ?? '').trim().toUpperCase() : '',
    })
  }
  return { rows, flags }
}

// ---------------------------------------------------------------------------
// Area building
// ---------------------------------------------------------------------------

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export type AreaBuildOptions = {
  /** DMA labels whose ZIP centres are this close are worked as one area. */
  mergeMiles?: number
  /** A ZIP this far from its DMA's median point is treated as a probable typo. */
  outlierMiles?: number
}

export function buildAreas(
  rows: ZipRow[],
  centroids: Centroids,
  markets: Map<string, { lat: number; lng: number }>,
  opts: AreaBuildOptions = {},
): AreaBuildResult {
  const mergeMiles = opts.mergeMiles ?? 30
  const outlierMiles = opts.outlierMiles ?? 150
  const flags: AreaFlag[] = []

  // 1. De-duplicate.
  const seen = new Set<string>()
  const unique: ZipRow[] = []
  for (const r of rows) {
    if (seen.has(r.zip)) {
      flags.push({ kind: 'DUPLICATE', zip: r.zip, label: r.label, detail: `${r.zip} (${r.city || r.label}) is listed more than once` })
      continue
    }
    seen.add(r.zip)
    unique.push(r)
  }

  // 2. Geocode and group by label.
  type Geo = ZipRow & { lat?: number; lng?: number; outlier?: boolean }
  const geo: Geo[] = unique.map(r => {
    const c = centroids[r.zip]
    return c ? { ...r, lat: c[0], lng: c[1] } : { ...r }
  })
  for (const g of geo) {
    if (g.lat === undefined) {
      flags.push({ kind: 'NOT_GEOCODED', zip: g.zip, label: g.label, detail: `${g.zip} (${g.city || g.label}) has no residential area — usually a PO-box or unique ZIP` })
    } else if (!inContiguous48(g.lat, g.lng!)) {
      flags.push({ kind: 'OUTSIDE_48', zip: g.zip, label: g.label, detail: `${g.zip} is outside the contiguous 48 states` })
      g.outlier = true
    }
  }

  const byLabel = new Map<string, Geo[]>()
  const unlabeled: Geo[] = []
  for (const g of geo) {
    if (!g.label) { unlabeled.push(g); continue }
    const list = byLabel.get(g.label) ?? []
    list.push(g)
    byLabel.set(g.label, list)
  }

  // 3. Outliers: far from the label's median point. The median resists the
  // very typo it is trying to catch; a mean would be dragged toward it.
  const centre = new Map<string, { lat: number; lng: number }>()
  for (const [label, list] of byLabel) {
    const pts = list.filter(g => g.lat !== undefined && !g.outlier)
    if (pts.length === 0) continue
    const mLat = median(pts.map(p => p.lat!))
    const mLng = median(pts.map(p => p.lng!))
    for (const p of pts) {
      const d = haversineDistance(mLat, mLng, p.lat!, p.lng!)
      if (pts.length > 1 && d > outlierMiles) {
        p.outlier = true
        flags.push({ kind: 'OUTLIER', zip: p.zip, label, detail: `${p.zip} (${p.city || label}, ${p.state}) sits ${Math.round(d)} mi from the rest of ${label} — check for a typo` })
      }
    }
    const good = pts.filter(p => !p.outlier)
    if (good.length) {
      centre.set(label, {
        lat: good.reduce((s, p) => s + p.lat!, 0) / good.length,
        lng: good.reduce((s, p) => s + p.lng!, 0) / good.length,
      })
    }
  }

  // 4. Rows with no label go to the nearest labelled centre.
  for (const g of unlabeled) {
    if (g.lat === undefined || centre.size === 0) {
      flags.push({ kind: 'NO_LABEL', zip: g.zip, detail: `${g.zip} (${g.city}) has no DMA and could not be placed` })
      continue
    }
    let best = ''
    let bestD = Infinity
    for (const [label, c] of centre) {
      const d = haversineDistance(c.lat, c.lng, g.lat, g.lng!)
      if (d < bestD) { bestD = d; best = label }
    }
    flags.push({ kind: 'NO_LABEL', zip: g.zip, label: best, detail: `${g.zip} (${g.city}) has no DMA — placed in ${best}, ${Math.round(bestD)} mi away` })
    byLabel.get(best)!.push({ ...g, label: best })
  }

  // 5. Merge labels a single truck can work together (union-find on centres).
  const labels = [...centre.keys()]
  const parent = new Map(labels.map(l => [l, l]))
  const find = (l: string): string => (parent.get(l) === l ? l : find(parent.get(l)!))
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = centre.get(labels[i])!
      const b = centre.get(labels[j])!
      if (haversineDistance(a.lat, a.lng, b.lat, b.lng) <= mergeMiles) {
        parent.set(find(labels[j]), find(labels[i]))
      }
    }
  }
  const groups = new Map<string, string[]>()
  for (const l of labels) {
    const root = find(l)
    groups.set(root, [...(groups.get(root) ?? []), l])
  }
  // Labels with no geocodable ZIPs at all still need an area to report against.
  for (const l of byLabel.keys()) if (!centre.has(l)) groups.set(l, [l])

  const areas: Area[] = []
  for (const members of groups.values()) {
    const all = members.flatMap(l => byLabel.get(l) ?? [])
    members.sort((a, b) => (byLabel.get(b)?.length ?? 0) - (byLabel.get(a)?.length ?? 0))
    const good = all.filter(g => g.lat !== undefined && !g.outlier)
    if (good.length === 0) continue
    const lat = good.reduce((s, p) => s + p.lat!, 0) / good.length
    const lng = good.reduce((s, p) => s + p.lng!, 0) / good.length
    let nearest: Area['nearestMarket'] = null
    for (const [name, c] of markets) {
      const d = haversineDistance(lat, lng, c.lat, c.lng)
      if (!nearest || d < nearest.distanceMiles) nearest = { name, distanceMiles: Math.round(d) }
    }
    const name = members.join(' / ')
    areas.push({
      id: slug(name),
      name,
      labels: members,
      zips: all.map(g => g.zip),
      residentialZips: all.filter(g => g.lat !== undefined && !g.outlier).length,
      lat, lng,
      spreadMiles: Math.round(Math.max(...good.map(p => haversineDistance(lat, lng, p.lat!, p.lng!)))),
      nearestMarket: nearest,
    })
  }
  areas.sort((a, b) => b.zips.length - a.zips.length || a.name.localeCompare(b.name))

  return { rows: rows.length, uniqueZips: unique.length, areas, flags }
}

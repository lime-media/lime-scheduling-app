/**
 * Multi-market planner — pure-function coverage.
 *
 * The solvers are checked against brute force on random small instances, since
 * a matching or assignment that is merely plausible would still produce a
 * confident-looking plan. The pricing cases pin the figures from the 23 Sep
 * 2026 analysis (44 areas: $297,000 a week at 3x12, $330,000 at 5x8).
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { maxPairing, type MatchEdge } from '@/lib/planning/matching'
import { minCostAssignment } from '@/lib/planning/assignment'
import { parseZipRows, buildAreas, type Area, type Centroids } from '@/lib/planning/areas'
import {
  addDays, freeFrom, earliestStart, latestSoftHoldTrucks, dateOptions, buildRoutes, priceProgram, capacityLeft, assign, candidateMatrix,
  DEFAULT_SETTINGS, type PlanSettings, type PlanTruck, type Route,
} from '@/lib/planning/planner'
import type { TruckJob } from '@/lib/truckTimeline'

// Deterministic PRNG so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

// ---------------------------------------------------------------------------
section('matching: exact vs brute force')

function bruteMatch(n: number, edges: MatchEdge[]): { pairs: number; miles: number } {
  let best = { pairs: 0, miles: 0 }
  const used = new Array<boolean>(n).fill(false)
  const go = (i: number, pairs: number, miles: number) => {
    if (i === edges.length) {
      if (pairs > best.pairs || (pairs === best.pairs && miles < best.miles - 1e-9)) best = { pairs, miles }
      return
    }
    go(i + 1, pairs, miles)
    const e = edges[i]
    if (!used[e.a] && !used[e.b]) {
      used[e.a] = used[e.b] = true
      go(i + 1, pairs + 1, miles + e.miles)
      used[e.a] = used[e.b] = false
    }
  }
  go(0, 0, 0)
  return best
}

let matchOk = 0
const MATCH_TRIALS = 200
const matchSizes = new Set<number>()
for (let t = 0; t < MATCH_TRIALS; t++) {
  // Seeds spread apart: consecutive seeds give an LCG near-identical first draws.
  const r = rng(t * 7919 + 13)
  const n = 2 + Math.floor(r() * 11)
  matchSizes.add(n)
  const edges: MatchEdge[] = []
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (r() < 0.45) edges.push({ a, b, miles: Math.round(r() * 300) })
  const got = maxPairing(n, edges)
  const want = bruteMatch(n, edges)
  const miles = got.pairs.reduce((s, p) => s + p.miles, 0)
  const disjoint = new Set(got.pairs.flatMap(p => [p.a, p.b])).size === got.pairs.length * 2
  if (disjoint && got.pairs.length === want.pairs && Math.abs(miles - want.miles) < 1e-6) matchOk++
}
eq(`exact on ${MATCH_TRIALS} random graphs`, matchOk, MATCH_TRIALS)
eq('random graphs span sizes 2 to 12', [Math.min(...matchSizes), Math.max(...matchSizes), matchSizes.size], [2, 12, 11])
{
  // A 40-node path, long-short-long-...: greedy takes the short edges and
  // strands every other node; the exact search pairs everything.
  const edges: MatchEdge[] = []
  for (let i = 0; i < 39; i++) edges.push({ a: i, b: i + 1, miles: i % 2 === 0 ? 100 : 1 })
  const got = maxPairing(40, edges)
  eq('exact beyond 30 nodes: 40-node path fully paired', [got.pairs.length, got.greedyClusters], [20, 0])
}
eq('no edges, no pairs', maxPairing(4, []).pairs.length, 0)
// A path a-b-c-d: pairing the short middle edge alone would strand both ends.
eq('prefers two pairs over one shorter pair',
  maxPairing(4, [{ a: 0, b: 1, miles: 100 }, { a: 1, b: 2, miles: 1 }, { a: 2, b: 3, miles: 100 }]).pairs.length, 2)

// ---------------------------------------------------------------------------
section('assignment: Hungarian vs brute force')

function bruteAssign(cost: number[][]): { served: number; total: number } {
  const n = cost.length
  const m = cost[0].length
  let best = { served: -1, total: Infinity }
  const used = new Array<boolean>(m).fill(false)
  const go = (i: number, served: number, total: number) => {
    if (i === n) {
      if (served > best.served || (served === best.served && total < best.total - 1e-9)) best = { served, total }
      return
    }
    go(i + 1, served, total) // leave unserved
    for (let j = 0; j < m; j++) {
      if (used[j] || !Number.isFinite(cost[i][j])) continue
      used[j] = true
      go(i + 1, served + 1, total + cost[i][j])
      used[j] = false
    }
  }
  go(0, 0, 0)
  return best
}

let assignOk = 0
const ASSIGN_TRIALS = 200
let underSupply = 0
for (let t = 0; t < ASSIGN_TRIALS; t++) {
  const r = rng(t * 104729 + 7)
  const n = 1 + Math.floor(r() * 5)
  // Include fewer trucks than routes: the under-supply path must be exact too.
  const m = Math.max(1, n - 2 + Math.floor(r() * 5))
  if (m < n) underSupply++
  const cost = Array.from({ length: n }, () => Array.from({ length: m }, () => (r() < 0.25 ? Infinity : Math.round(r() * 1000))))
  const got = minCostAssignment(cost)
  const want = bruteAssign(cost)
  const cols = got.colForRow.filter(j => j >= 0)
  if (n - got.unserved === want.served && Math.abs(got.totalCost - want.total) < 1e-6 && new Set(cols).size === cols.length) assignOk++
}
eq(`optimal on ${ASSIGN_TRIALS} random matrices`, assignOk, ASSIGN_TRIALS)
eq('some trials have fewer trucks than routes', underSupply > 20, true)
eq('all blocked -> all unserved', minCostAssignment([[Infinity, Infinity]]).unserved, 1)

// ---------------------------------------------------------------------------
section('parsing the client file')

const csv = `Pizza Box Toppers,,,
DMA Name,Zip,City,State
Greensboro,27260,High Point,NC
None,51503,Council Bluffs,IA
DMA Name,Zip,City,State
Springfield,1103,Springfield,MA
Bogus,ABCDE,Nowhere,XX`
const parsed = parseZipRows(csv)
eq('title row, repeated header and bad ZIP skipped', parsed.rows.length, 3)
eq('leading zero restored', parsed.rows[2].zip, '01103')
eq('"None" DMA read as blank', parsed.rows[1].label, '')
eq('invalid ZIP flagged', parsed.flags.map(f => f.kind), ['INVALID_ZIP'])
eq('tab-separated with no header', parseZipRows('Omaha\t68102\tOmaha\tNE').rows[0], { label: 'Omaha', zip: '68102', city: 'Omaha', state: 'NE' })

// ---------------------------------------------------------------------------
section('building areas')

const C: Centroids = {
  '10001': [35.0, -97.0], '10002': [35.05, -97.05], '10003': [35.1, -97.0],   // Alpha
  '20001': [35.2, -97.2],                                                      // Beta, ~15 mi from Alpha -> merged
  '30001': [40.0, -90.0], '30002': [40.05, -90.0],                            // Gamma
  '30009': [30.0, -80.0],                                                      // Gamma typo, ~900 mi away
  '40001': [40.1, -90.1],                                                      // unlabeled, near Gamma
}
const rows = [
  { label: 'Alpha', zip: '10001', city: '', state: 'OK' },
  { label: 'Alpha', zip: '10002', city: '', state: 'OK' },
  { label: 'Alpha', zip: '10003', city: '', state: 'OK' },
  { label: 'Alpha', zip: '10003', city: '', state: 'OK' },   // duplicate
  { label: 'Alpha', zip: '10099', city: '', state: 'OK' },   // PO box, not a ZCTA
  { label: 'Beta', zip: '20001', city: '', state: 'OK' },
  { label: 'Gamma', zip: '30001', city: '', state: 'IL' },
  { label: 'Gamma', zip: '30002', city: '', state: 'IL' },
  { label: 'Gamma', zip: '30009', city: '', state: 'IL' },
  { label: '', zip: '40001', city: '', state: 'IL' },
]
const built = buildAreas(rows, C)
eq('flags', built.flags.map(f => f.kind).sort(), ['DUPLICATE', 'NOT_GEOCODED', 'NO_LABEL', 'OUTLIER'])
eq('Alpha and Beta merge into one area', built.areas.map(a => a.name).sort(), ['Alpha / Beta', 'Gamma'])
const gamma = built.areas.find(a => a.name === 'Gamma')!
eq('unlabeled ZIP joins the nearest area', gamma.zips.includes('40001'), true)
eq('outlier kept in the list but not the centre', [gamma.zips.includes('30009'), gamma.lat < 41], [true, true])
{
  const cc: Centroids = { '32304': [30.45, -84.35], '23303': [37.9, -75.5], '30001': [40, -90], '30002': [40.05, -90] }
  const two = buildAreas([
    { label: 'Tallahassee', zip: '32304', city: '', state: 'FL' }, { label: 'Tallahassee', zip: '23303', city: '', state: 'FL' },
    { label: 'Gamma', zip: '30001', city: '', state: 'IL' }, { label: 'Gamma', zip: '30002', city: '', state: 'IL' },
  ], cc)
  eq('two-ZIP DMA with a typo is kept, not dropped', two.areas.map(a => a.name).sort(), ['Gamma', 'Tallahassee'])
  eq('...and flagged as uncertain', [two.areas.find(a => a.name === 'Tallahassee')!.locationUncertain, two.flags.map(f => f.kind)], [true, ['UNCERTAIN_LOCATION']])
  const po = buildAreas([{ label: 'PO Only', zip: '70821', city: '', state: 'LA' }, { label: 'Gamma', zip: '30001', city: '', state: 'IL' }], cc)
  eq('all-PO-box DMA is reported as not in the plan', [po.unplaced.map(u => u.label), po.flags.some(f => f.kind === 'NOT_PLACED')], [['PO Only'], true])
  const order1 = buildAreas([{ label: 'B', zip: '30001', city: '', state: '' }, { label: 'A', zip: '30002', city: '', state: '' }], cc)
  const order2 = buildAreas([{ label: 'A', zip: '30002', city: '', state: '' }, { label: 'B', zip: '30001', city: '', state: '' }], cc)
  eq('area ids do not depend on paste order', order1.areas[0].id, order2.areas[0].id)
}
{
  // A ZIP about 68 mi out.
  const far = buildAreas(
    [{ label: 'Delta', zip: '50001', city: '', state: '' }, { label: 'Delta', zip: '50002', city: '', state: '' }, { label: 'Delta', zip: '50003', city: '', state: '' }],
    { '50001': [44.0, -100.0], '50002': [44.02, -100.0], '50003': [45.5, -100.0] },
  )
  eq('over an hour out: flagged as an assumption', far.flags.filter(f => f.kind === 'BEYOND_REACH').map(f => f.zip), ['50003'])
  eq('still in the area', far.areas[0].zips.length, 3)
}

// ---------------------------------------------------------------------------
section('routes')

const area = (id: string, lat: number, lng: number): Area =>
  ({ id, name: id, labels: [id], zips: [], residentialZips: 1, lat, lng, spreadMiles: 0, locationUncertain: false })
// Dallas, Fort Worth (~30 mi), Houston (~225 mi from Dallas), Denver (far).
const A = [area('dal', 32.78, -96.80), area('ftw', 32.75, -97.33), area('hou', 29.76, -95.37), area('den', 39.74, -104.99)]
const S: PlanSettings = { ...DEFAULT_SETTINGS, planStart: '2026-10-12', planThrough: '2027-03-31', today: '2026-09-23' }
eq('5x8: one route per area', buildRoutes(A, { ...S, model: '5x8' }).routes.length, 4)
const r312 = buildRoutes(A, S).routes
eq('3x12: Dallas pairs, Denver solo', r312.map(r => r.areaIds.length).sort(), [1, 1, 2])
eq('3x12: tightest pair chosen', r312.find(r => r.areaIds.length === 2)!.areaIds.sort(), ['dal', 'ftw'])

// ---------------------------------------------------------------------------
section('when can a truck start')

const job = (start: string, end: string, market: string, state: string, lat: number, lng: number): TruckJob =>
  ({ start, end, market, state, lat, lng, source: 'SCHEDULE', program: 'X', yieldable: false })
const byId = new Map(A.map(a => [a.id, a]))
const solo = (id: string): Route => ({ id, areaIds: [id], name: id, hopRoadMiles: 0 })

eq('free from after the last clash', freeFrom([job('2026-10-01', '2026-10-20', 'Denver', 'CO', 39.74, -104.99)], '2026-10-12', '2027-03-31'), '2026-10-21')
eq('never free if booked past plan-through', freeFrom([job('2026-10-01', '2027-06-01', 'Denver', 'CO', 39.74, -104.99)], '2026-10-12', '2027-03-31'), null)

// Truck finishing in Denver on 20 Oct, route in Dallas (~660 mi): 2 transport days.
const denverTruck: PlanTruck = { truckNumber: 'T1', jobs: [job('2026-10-01', '2026-10-20', 'Denver', 'CO', 39.74, -104.99)], gps: { lat: 32.78, lng: -96.80 }, gpsLabel: 'Dallas, TX' }
const cand = earliestStart(denverTruck, solo('dal'), byId, S)!
eq('origin is the release point, not GPS', cand.originLabel, 'Denver, CO')
eq('start = release + transport days', cand.start, addDays('2026-10-21', 2))
eq('reposition cost charged beyond the service area', cand.repositionCost > 0, true)

const localTruck: PlanTruck = { truckNumber: 'T2', jobs: [], gps: { lat: 32.8, lng: -96.9 }, gpsLabel: 'Dallas, TX' }
const local = earliestStart(localTruck, solo('dal'), byId, S)!
eq('idle local truck starts on day one, no cost', [local.start, local.repositionCost], ['2026-10-12', 0])

// Uniform start before the Denver truck is free: only the local truck qualifies.
const routes2 = [solo('dal'), solo('ftw')]
const trucks2 = [denverTruck, localTruck]
const m2 = candidateMatrix(routes2, trucks2, byId, S)
eq('live by 12 Oct: short by one', assign(routes2, trucks2, m2, '2026-10-12', S.planStart).shortBy, 1)
eq('live by 30 Oct: both served', assign(routes2, trucks2, m2, '2026-10-30', S.planStart).shortBy, 0)

section('start date vs. transport we absorb')
{
  // One Dallas route. A truck idle in Denver today (costs transport), and a
  // Dallas truck that is busy until 18 Oct (free, local).
  const far: PlanTruck = { truckNumber: 'FAR', jobs: [], gps: { lat: 39.74, lng: -104.99 }, gpsLabel: 'Denver, CO' }
  const near: PlanTruck = { truckNumber: 'NEAR', jobs: [job('2026-10-01', '2026-10-17', 'Dallas', 'TX', 32.78, -96.80)], gps: { lat: 32.78, lng: -96.80 }, gpsLabel: 'Dallas, TX' }
  const r = [solo('dal')]
  const t = [far, near]
  const m = candidateMatrix(r, t, byId, S)
  const early = assign(r, t, m, '2026-10-14', S.planStart)
  const later = assign(r, t, m, '2026-10-19', S.planStart)
  eq('early date: only the far truck makes it, and we absorb its transport', [early.assignments[0].truckNumber, early.repositionCost > 0], ['FAR', true])
  eq('a week later: the local truck, nothing absorbed', [later.assignments[0].truckNumber, later.repositionCost], ['NEAR', 0])
  const table = dateOptions(r, t, m, S)
  eq('the table shows the cost falling as the date moves out', table.options[0].liveBy.repositionCost > table.options[table.options.length - 1].liveBy.repositionCost, true)
  eq('first date everything is live', table.firstFullLiveBy, early.assignments[0].start)

  // Plateau, then a drop: two far trucks (same cost) free now and in a week,
  // and a local truck free in three weeks. Two equal rows must not end the
  // table before the $0 option.
  const far2: PlanTruck = { truckNumber: 'FAR2', jobs: [job('2026-10-01', '2026-10-18', 'Denver', 'CO', 39.74, -104.99)], gps: null, gpsLabel: '' }
  const late: PlanTruck = { truckNumber: 'LATE', jobs: [job('2026-10-01', '2026-11-02', 'Dallas', 'TX', 32.78, -96.80)], gps: null, gpsLabel: '' }
  const tp = [far, far2, late]
  const mp = candidateMatrix(r, tp, byId, S)
  const plateau = dateOptions(r, tp, mp, S)
  const lastRow = plateau.options[plateau.options.length - 1]
  eq('cheapest date found past a plateau', [plateau.cheapestDate, lastRow.date, lastRow.liveBy.repositionCost], ['2026-11-03', '2026-11-03', 0])

  // Two free local trucks, one ready now and one next week: same $0, so the
  // earlier start wins even though it is a few miles further away.
  const nowT: PlanTruck = { truckNumber: 'NOW', jobs: [], gps: { lat: 32.9, lng: -96.9 }, gpsLabel: 'Dallas, TX' }
  const laterT: PlanTruck = { truckNumber: 'LATER', jobs: [job('2026-10-01', '2026-10-15', 'Dallas', 'TX', 32.78, -96.80)], gps: { lat: 32.78, lng: -96.80 }, gpsLabel: 'Dallas, TX' }
  const m3 = candidateMatrix(r, [laterT, nowT], byId, S)
  eq('equal cost: earlier start wins', assign(r, [laterT, nowT], m3, '2026-10-30', S.planStart).assignments[0].truckNumber, 'NOW')
  eq('each route names the truck that serves it', assign(r, [nowT], candidateMatrix(r, [nowT], byId, S), '2026-10-30', S.planStart).assignments[0].truckNumber, 'NOW')
}

// ---------------------------------------------------------------------------
section('pricing (rate card, no agreement)')

const p312 = priceProgram(44, '3x12')
eq('3x12 44 areas: $1,800/day', p312.effectiveDailyRate, 1800)
eq('3x12 base per week', p312.baseMediaPerWeek, 237600)
eq('3x12 with shadow fencing per week', p312.totalPerWeek, 297000)
const p58 = priceProgram(44, '5x8')
eq('5x8 base per week', p58.baseMediaPerWeek, 264000)
eq('5x8 with shadow fencing per week', p58.totalPerWeek, 330000)
eq('same $150 per truck-hour', [p312.perTruckHour, p58.perTruckHour], [150, 150])

section('capacity')
eq('82 - 7 - (20..25) - 25', capacityLeft({ activeTrucks: 82, maintenanceReserve: 7, reservedLow: 20, reservedHigh: 25, renewingTrucks: 0, programTrucks: 25 }), { low: 25, high: 30 })
eq('with Alloy renewing at 15', capacityLeft({ activeTrucks: 82, maintenanceReserve: 7, reservedLow: 20, reservedHigh: 25, renewingTrucks: 15, programTrucks: 25 }), { low: 10, high: 15 })

section('AT&T soft-hold reservation')
{
  const h = (tn: string, start: string) => ({ truck_number: tn, start_date: new Date(start + 'T00:00:00Z') })
  eq('only the latest month counts', [...latestSoftHoldTrucks([h('A', '2026-09-01'), h('B', '2026-10-01'), h('C', '2026-10-01')])].sort(), ['B', 'C'])
  eq('none on file, none reserved', latestSoftHoldTrucks([]).size, 0)
}

// ---------------------------------------------------------------------------
section('xlsx reader')
{
  // Build a minimal two-sheet .xlsx in memory: a real zip of the XML parts.
  const { deflateRawSync } = require('zlib') as typeof import('zlib')
  const { readXlsx, xlsxToCsv } = require('@/lib/planning/xlsx') as typeof import('@/lib/planning/xlsx')
  const crc32 = (b: Buffer) => {
    let c = ~0
    for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
    return ~c >>> 0
  }
  const zip = (files: Record<string, string>) => {
    const locals: Buffer[] = []; const centrals: Buffer[] = []; let off = 0
    for (const [name, text] of Object.entries(files)) {
      const raw = Buffer.from(text, 'utf8'); const data = deflateRawSync(raw); const nm = Buffer.from(name)
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8)
      lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26)
      const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10)
      ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42)
      locals.push(lh, nm, data); centrals.push(ch, nm); off += 30 + nm.length + data.length
    }
    const cd = Buffer.concat(centrals)
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10)
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16)
    return Buffer.concat([...locals, cd, end])
  }
  const sheet = (rows: string) => `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`
  const book = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="East" sheetId="1" r:id="rId1"/><sheet name="West &amp; South" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>DMA Name</t></si><si><t>Zip</t></si><si><r><t>Green</t></r><r><t>sboro</t></r></si><si><t xml:space="preserve">A &amp; B, "C"</t></si></sst>',
    'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>27260</v></c></row>'),
    'xl/worksheets/sheet2.xml': sheet('<row r="1"><c r="A1" t="s"><v>3</v></c><c r="C1" t="inlineStr"><is><t>1103</t></is></c></row>'),
  })
  const sheets = readXlsx(book)
  eq('sheet names in workbook order', sheets.map(s => s.name), ['East', 'West & South'])
  eq('rich-text shared string joined', sheets[0].rows[1], ['Greensboro', '27260'])
  eq('gap column kept, inline string read', sheets[1].rows[0], ['A & B, "C"', '', '1103'])
  eq('csv quotes a comma and doubles quotes', xlsxToCsv(book).split('\n')[2], '"A & B, ""C""",,1103')
  eq('parses through to ZIP rows', parseZipRows(xlsxToCsv(book)).rows[0], { label: 'Greensboro', zip: '27260', city: '', state: '' })
  const { columnIndex } = require('@/lib/planning/xlsx') as typeof import('@/lib/planning/xlsx')
  eq('last real column', columnIndex('XFD1'), 16383)
  eq('crafted column refs are rejected, not padded to', [columnIndex('XFE1'), columnIndex('AAAAAAA1'), columnIndex('ZZZZZZZZ1')], [-1, -1, -1])
  const bomb = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c><c r="ZZZZZZZZ1" t="inlineStr"><is><t>x</t></is></c></row>'),
  })
  eq('a crafted cell reference is skipped', readXlsx(bomb)[0].rows[0], ['ok'])
}

// ---------------------------------------------------------------------------
section('Claude layer: code-side checks')
{
  const { verifyFinding, unverifiedNumbers } = require('@/lib/planning/claude') as typeof import('@/lib/planning/claude')
  const cz: Centroids = { '32303': [30.49, -84.33], '32304': [30.45, -84.35], '31602': [30.87, -83.34], '99501': [61.2, -149.9] }
  const ctx = { rows: [
    { label: 'Tallahassee', zip: '23303', city: 'Tallahassee', state: 'FL' },
    { label: 'Tallahassee', zip: '32304', city: 'Tallahassee', state: 'FL' },
    { label: 'Tallahassee', zip: '31602', city: 'Valdosta', state: 'GA' },
  ], centroids: cz }
  const f = (suggested: string | null) => ({ kind: 'LIKELY_TYPO' as const, zip: '23303', dma: 'Tallahassee', detail: '', suggested_zip: suggested, suggested_dma: null })
  eq('suggestion that exists near its DMA is verified', verifyFinding(f('32303'), ctx).verified, true)
  eq('suggestion that does not exist is not', verifyFinding(f('32399'), ctx).verified, false)
  eq('suggestion far from its DMA is not', verifyFinding(f('99501'), ctx).verified, false)

  const facts = { price_per_week: 297000, trucks: 25, first_start: '2026-10-12', rate_per_truck_hour: 150, left: { low: 25, high: 30 }, hours_per_day: 12, drivers_per_paired_route: 2 }
  eq('plan numbers pass in any format', unverifiedNumbers('25 trucks from Oct 12 at $297,000 a week, or $297K, $150 per hour; 25 to 30 left.', facts), [])
  eq('schedule constants in the plan pass', unverifiedNumbers('three 12-hour days, 2 drivers', facts), [])
  eq('small counts are checked too', unverifiedNumbers('only 4 trucks', facts), ['4'])
  eq('invented arithmetic is caught', unverifiedNumbers('a 10% saving of $33,000 against 44 trucks', facts), ['10%', '$33,000', '44'])
  const { verifiableFacts } = require('@/lib/planning/claude') as typeof import('@/lib/planning/claude')
  const withFile = { trucks: 25, client_request: 'Client wants 999 trucks', list_corrections: ['OUTLIER: 777'] } as unknown as Parameters<typeof verifiableFacts>[0]
  eq('numbers from the uploaded file cannot vouch for themselves', unverifiedNumbers('999 trucks, 777', verifiableFacts(withFile)), ['999', '777'])

  eq('one-ZIP DMA: suggestion exists but is not verified', verifyFinding({ kind: 'LIKELY_TYPO', zip: '23303', dma: 'Solo', detail: '', suggested_zip: '32303', suggested_dma: null },
    { rows: [{ label: 'Solo', zip: '23303', city: '', state: '' }], centroids: cz }).verified, false)
  eq('Claude misspells the DMA: the listed label is used', verifyFinding({ kind: 'LIKELY_TYPO', zip: '23303', dma: 'Talahassee', detail: '', suggested_zip: '32303', suggested_dma: null }, ctx).verified, true)

  const { findLeaks } = require('@/lib/planning/leaks') as typeof import('@/lib/planning/leaks')
  const forbidden = ['1261', '$6,624', 'AT&T', 'ATT', 'absorb*']
  eq('truck number, cost and stems are caught', findLeaks('Truck 1261 costs $6,624; we absorbed it for AT&T.', forbidden), ['1261', '$6,624', 'AT&T', 'absorb*'])
  eq('no false hit inside ordinary words', findLeaks('Attached is the plan; 12610 impressions.', forbidden), [])
}

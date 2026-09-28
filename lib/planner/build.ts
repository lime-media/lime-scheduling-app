/**
 * Ops planner — the pivot behind the Planner tab.
 *
 * Every truck-day in the window gets one entry per thing on it: a scheduled
 * shift (with its hours and driver), maintenance, a reservation (a client's
 * hold request is one too), a committed reservation, an AT&T soft hold, or
 * nothing (open).
 *
 * Each pivot is a tree of levels (PIVOT_LEVELS): truck → driver; driver →
 * campaign → market → truck; client → campaign → market → asset; campaign →
 * market → asset → driver; market → truck → campaign. The last level is the
 * row with the day cells. Cells show the shift's 8 / 10 / 12 ("R" for a
 * reservation with no hours on file) — except under the truck pivot, where
 * the bars are labelled with the market instead.
 *
 * Pure: the API route loads the data and passes it in.
 */

export type EntryKind = 'SCHEDULED' | 'MAINTENANCE' | 'COMMITTED' | 'RESERVATION' | 'ATT_SOFT' | 'OPEN'

export type PlannerShift = {
  truck: string
  date: string            // YYYY-MM-DD
  minutes: number | null
  driverId: string | null
  driverName: string | null
  client: string
  program: string
  market: string
}

export type PlannerHold = {
  id: string
  truck: string
  start: string
  end: string
  status: 'HOLD' | 'COMMITTED' | 'ATT_SOFT'
  source: string          // CLIENT = a client hold request
  client: string
  market: string
  hours: number | null    // from the quote, when it was quoted here
  opportunityId: string | null
  opportunityName: string | null
  campaignGroupId: string | null
}

export type Entry = {
  kind: EntryKind
  truck: string
  date: string
  /** Shown in the cell: 8 / 10 / 12, or null for "R" (reservation, hours unknown) and open days. */
  hours: number | null
  driver: string | null
  client: string
  campaign: string
  market: string
  /** Groups consecutive days of the same thing into one bar. */
  barKey: string
  detail: string
}

export type Pivot = 'truck' | 'driver' | 'client' | 'campaign' | 'market'


export const UNCLASSIFIED = 'Unclassified'
export const OPEN_CAPACITY = 'Open capacity'

const addDays = (d: string, n: number) => {
  const x = new Date(d + 'T00:00:00Z')
  x.setUTCDate(x.getUTCDate() + n)
  return x.toISOString().slice(0, 10)
}

/** Monday of the previous week through the Sunday six weeks after this week: eight weeks. */
export function plannerWindow(today: string, weeksAhead = 6): { from: string; to: string; days: string[] } {
  const t = new Date(today + 'T00:00:00Z')
  const dow = (t.getUTCDay() + 6) % 7 // Monday = 0
  const from = addDays(today, -dow - 7)
  const to = addDays(from, (weeksAhead + 2) * 7 - 1)
  const days: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d)
  return { from, to, days }
}

/** Shift minutes to the 8 / 10 / 12 the planner shows (nearest whole hour). */
export function shiftHours(minutes: number | null): number | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null
  return Math.round(minutes / 60)
}

/** One spelling per market: trims the stray spaces standard_market names carry and fixes comma spacing. */
export function normalizeMarket(m: string): string {
  return (m || '').trim().replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ')
}

const isMaintenance = (s: PlannerShift) => s.program.trim().toLowerCase() === 'truck maintenance' || s.client.trim().toLowerCase() === 'truck maintenance'

function reservationCampaign(h: PlannerHold): string {
  if (h.opportunityName) return h.opportunityName
  if (h.opportunityId) return `Opportunity ${h.opportunityId}`
  return `Reservation – ${h.client || 'no client'}${h.market ? ` – ${h.market}` : ''}`
}

/**
 * All entries for the window. Per truck-day: every shift that day (summed by
 * program and driver), every reservation that covers it, and an AT&T soft hold
 * only where nothing else is booked (the grid shows the real shift on those
 * days). A truck-day with nothing on it is OPEN.
 */
export function buildEntries(input: { trucks: string[]; days: string[]; shifts: PlannerShift[]; holds: PlannerHold[] }): Entry[] {
  const { trucks, days } = input
  const inWindow = new Set(days)
  const out: Entry[] = []
  const byTruckDay = new Map<string, Entry[]>()
  const push = (e: Entry) => {
    out.push(e)
    const k = `${e.truck}|${e.date}`
    byTruckDay.set(k, [...(byTruckDay.get(k) ?? []), e])
  }

  // Shifts: one entry per truck-day per program + driver, minutes summed (split shifts).
  const shiftGroups = new Map<string, PlannerShift & { total: number | null }>()
  for (const s of input.shifts) {
    if (!inWindow.has(s.date)) continue
    const k = `${s.truck}|${s.date}|${s.program}|${s.driverId ?? ''}`
    const cur = shiftGroups.get(k)
    if (cur) cur.total = cur.total === null || s.minutes === null ? (cur.total ?? s.minutes) : cur.total + s.minutes
    else shiftGroups.set(k, { ...s, total: s.minutes })
  }
  for (const s of shiftGroups.values()) {
    const maint = isMaintenance(s)
    push({
      kind: maint ? 'MAINTENANCE' : 'SCHEDULED',
      truck: s.truck, date: s.date,
      hours: maint ? null : shiftHours(s.total),
      driver: s.driverName ?? (s.driverId ? `Driver ${s.driverId.slice(0, 8)}` : null),
      client: s.client || 'No client',
      campaign: s.program || 'No program',
      market: normalizeMarket(s.market),
      barKey: `S|${s.program}|${s.driverId ?? ''}`,
      detail: [s.program, s.market, s.client].filter(Boolean).join(' · '),
    })
  }

  // Reservations, committed reservations and client requests, day by day.
  const soft: PlannerHold[] = []
  for (const h of input.holds) {
    if (h.status === 'ATT_SOFT') { soft.push(h); continue }
    // A client's hold request is a reservation like any other.
    const kind: EntryKind = h.status === 'COMMITTED' ? 'COMMITTED' : 'RESERVATION'
    for (let d = h.start < days[0] ? days[0] : h.start; d <= h.end && d <= days[days.length - 1]; d = addDays(d, 1)) {
      push({
        kind, truck: h.truck, date: d,
        hours: h.hours,
        driver: null,
        client: h.client || 'No client',
        campaign: reservationCampaign(h),
        market: normalizeMarket(h.market),
        barKey: `H|${h.id}`,
        detail: [kind === 'COMMITTED' ? 'Committed (won)' : h.source === 'CLIENT' ? 'Reservation (client request)' : 'Reservation', h.market, h.client].filter(Boolean).join(' · '),
      })
    }
  }

  // AT&T soft holds fill only the days nothing else is on.
  for (const h of soft) {
    for (let d = h.start < days[0] ? days[0] : h.start; d <= h.end && d <= days[days.length - 1]; d = addDays(d, 1)) {
      if (byTruckDay.has(`${h.truck}|${d}`)) continue
      push({
        kind: 'ATT_SOFT', truck: h.truck, date: d, hours: null, driver: null,
        client: '160over90 (AT&T)', campaign: 'AT&T soft hold', market: '',
        barKey: `A|${h.id}`, detail: 'AT&T soft hold',
      })
    }
  }

  // Everything else is open.
  for (const truck of trucks) {
    for (const d of days) {
      if (byTruckDay.has(`${truck}|${d}`)) continue
      push({ kind: 'OPEN', truck, date: d, hours: null, driver: null, client: OPEN_CAPACITY, campaign: OPEN_CAPACITY, market: '', barKey: 'O', detail: 'Open' })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Pivot tree
// ---------------------------------------------------------------------------

export type Dimension = 'truck' | 'driver' | 'client' | 'campaign' | 'market'

/** The levels of each pivot, top to bottom; the last is the row with the day cells. */
export const PIVOT_LEVELS: Record<Pivot, Dimension[]> = {
  truck:    ['truck', 'driver'],
  driver:   ['driver', 'campaign', 'market', 'truck'],
  client:   ['client', 'campaign', 'market', 'truck'],
  campaign: ['campaign', 'market', 'truck', 'driver'],
  market:   ['market', 'truck', 'campaign'],
}

export const UNASSIGNED = 'Unassigned'
export const NO_MARKET = 'No market'
export const OPEN_ROW = 'Open'

export type PlannerNode = {
  /** Unique across the tree: the path of values from the top. */
  key: string
  dim: Dimension
  value: string
  depth: number
  /** Sorts last and reads as "not really a group": Unclassified, Unassigned, No market, Open. */
  unclassified: boolean
  children: PlannerNode[]
  /** Leaf rows only: the entries on each day. */
  cells: Record<string, Entry[]>
  /** Leaf rows only: the entry each day is drawn with (computed once, not per render). */
  top: Record<string, Entry>
  /** Leaf rows beneath this node (1 for a leaf). */
  leafCount: number
  /** Trucks under this node on each day (non-open entries; open entries in the open group). */
  trucksByDay: Record<string, number>
}

/** An entry's value at one level. Missing drivers and markets get a stated placeholder, never a guess. */
function valueOf(e: Entry, dim: Dimension, depth: number): { value: string; unclassified: boolean } {
  switch (dim) {
    case 'truck': return { value: e.truck, unclassified: false }
    case 'driver': return e.driver ? { value: e.driver, unclassified: false } : { value: depth === 0 ? UNCLASSIFIED : UNASSIGNED, unclassified: true }
    case 'client': return { value: e.client, unclassified: false }
    case 'campaign': return { value: e.campaign, unclassified: false }
    case 'market': return e.market ? { value: e.market, unclassified: false } : { value: depth === 0 ? UNCLASSIFIED : NO_MARKET, unclassified: true }
  }
}

/**
 * The path an entry takes down a pivot. Open days carry no driver, client,
 * campaign or market, so they get a short path of their own: under the truck
 * pivot a truck's "Open" row, elsewhere an "Open capacity" group of trucks.
 */
function pathOf(e: Entry, pivot: Pivot): { dim: Dimension; value: string; unclassified: boolean }[] {
  if (e.kind === 'OPEN') {
    return pivot === 'truck'
      ? [{ dim: 'truck', value: e.truck, unclassified: false }, { dim: 'driver', value: OPEN_ROW, unclassified: true }]
      : [{ dim: PIVOT_LEVELS[pivot][0], value: OPEN_CAPACITY, unclassified: true }, { dim: 'truck', value: e.truck, unclassified: false }]
  }
  return PIVOT_LEVELS[pivot].map((dim, depth) => ({ dim, ...valueOf(e, dim, depth) }))
}

const sortNodes = (a: PlannerNode, b: PlannerNode) =>
  Number(a.value === OPEN_CAPACITY || a.value === OPEN_ROW) - Number(b.value === OPEN_CAPACITY || b.value === OPEN_ROW)
  || Number(a.unclassified) - Number(b.unclassified)
  || a.value.localeCompare(b.value, undefined, { numeric: true })

/**
 * Build the pivot tree. `kinds` filters which entries are shown. `trucks`,
 * for the truck pivot, keeps every truck in the roster even when the filters
 * leave it nothing to show (turning Open off must not make idle trucks vanish).
 *
 * Node keys escape each value, so a value containing "/" or ":" (opportunity
 * names often do: "AT&T / Hispanic Q3") can never collide with a deeper path.
 */
export function pivotTree(entries: Entry[], pivot: Pivot, kinds?: Set<EntryKind>, trucks?: string[]): PlannerNode[] {
  const blank = (key: string, dim: Dimension, value: string, depth: number, unclassified: boolean): PlannerNode =>
    ({ key, dim, value, depth, unclassified, children: [], cells: {}, top: {}, leafCount: 0, trucksByDay: {} })
  const root = blank('', 'truck', '', -1, false)
  const index = new Map<string, PlannerNode>()
  const dayTrucks = new Map<string, Map<string, Set<string>>>() // node key → date → trucks
  const child = (parent: PlannerNode, dim: Dimension, value: string, depth: number, unclassified: boolean) => {
    const key = `${parent.key}/${dim}:${encodeURIComponent(value)}`
    let node = index.get(key)
    if (!node) {
      node = blank(key, dim, value, depth, unclassified)
      index.set(key, node)
      parent.children.push(node)
    }
    return node
  }
  if (pivot === 'truck') for (const t of trucks ?? []) child(root, 'truck', t, 0, false)
  for (const e of entries) {
    if (kinds && !kinds.has(e.kind)) continue
    let parent = root
    const path = pathOf(e, pivot)
    path.forEach((step, depth) => {
      const node = child(parent, step.dim, step.value, depth, step.unclassified)
      const byDay = dayTrucks.get(node.key) ?? new Map<string, Set<string>>()
      dayTrucks.set(node.key, byDay)
      byDay.set(e.date, (byDay.get(e.date) ?? new Set()).add(e.truck))
      if (depth === path.length - 1) (node.cells[e.date] ??= []).push(e)
      parent = node
    })
  }
  for (const [key, byDay] of dayTrucks) {
    const node = index.get(key)!
    for (const [d, t] of byDay) node.trucksByDay[d] = t.size
  }
  const finish = (n: PlannerNode): number => {
    n.children.sort(sortNodes)
    if (n.children.length === 0) {
      for (const [d, list] of Object.entries(n.cells)) n.top[d] = primary(list)
      n.leafCount = 1
    } else {
      n.leafCount = n.children.reduce((sum, c) => sum + finish(c), 0)
    }
    return n.leafCount
  }
  root.children.forEach(finish)
  root.children.sort(sortNodes)
  return root.children
}

/**
 * What each truck is doing each day across the WHOLE order — not just the
 * group it sits under — for the thin strip on a truck's own row. Scoping it to
 * the group made a truck working Dallas Mon-Wed and Austin Thu-Fri look idle
 * on Thu-Fri under "Dallas".
 */
export function truckDayTop(entries: Entry[], kinds?: Set<EntryKind>): Map<string, Record<string, Entry>> {
  const all = new Map<string, Record<string, Entry[]>>()
  for (const e of entries) {
    if (kinds && !kinds.has(e.kind)) continue
    const t = all.get(e.truck) ?? {}
    ;(t[e.date] ??= []).push(e)
    all.set(e.truck, t)
  }
  const out = new Map<string, Record<string, Entry>>()
  for (const [truck, days] of all) {
    const top: Record<string, Entry> = {}
    for (const [d, list] of Object.entries(days)) top[d] = primary(list)
    out.set(truck, top)
  }
  return out
}

/** Whether an entry matches a search, on any of the fields the pivots use. */
export function entryMatches(e: Entry, q: string): boolean {
  if (!q) return true
  return [e.truck, e.driver ?? '', e.client, e.campaign, e.market].some(v => v.toLowerCase().includes(q))
}

/** Leaf rows under a node, in display order. */
export function leaves(n: PlannerNode): PlannerNode[] {
  return n.children.length === 0 ? [n] : n.children.flatMap(leaves)
}

/** The label a bar carries under the truck pivot: where the truck is. */
export function marketLabel(e: Entry): string {
  if (e.kind === 'OPEN') return ''
  if (e.kind === 'ATT_SOFT') return 'AT&T soft hold'
  if (e.kind === 'MAINTENANCE') return e.market ? `Maintenance · ${e.market}` : 'Maintenance'
  return e.market || e.campaign
}

/** What a cell shows: hours, or "R" for a reservation with no hours on file; empty for open and non-hour entries. */
export function cellText(e: Entry): string {
  if (e.hours !== null) return String(e.hours)
  if (e.kind === 'RESERVATION') return 'R'
  if (e.kind === 'COMMITTED') return 'C'
  if (e.kind === 'MAINTENANCE') return 'M'
  return ''
}

/** The same facts in words, for screen readers and keyboard users. */
export function describeEntry(e: Entry): string {
  const what = { SCHEDULED: 'Scheduled', MAINTENANCE: 'Maintenance', COMMITTED: 'Committed (won)', RESERVATION: 'Reservation', ATT_SOFT: 'AT&T soft hold', OPEN: 'Open' }[e.kind]
  if (e.kind === 'OPEN') return `Truck ${e.truck}: open`
  return [
    `Truck ${e.truck}: ${what}`,
    e.hours !== null ? `${e.hours} hours` : e.kind === 'RESERVATION' || e.kind === 'COMMITTED' ? 'hours not on file' : null,
    e.campaign, e.client, e.market || null, e.driver ? `driver ${e.driver}` : null,
  ].filter(Boolean).join(', ')
}

/** The entry a cell is coloured by when several share it: real work first. */
export const KIND_PRIORITY: EntryKind[] = ['SCHEDULED', 'MAINTENANCE', 'COMMITTED', 'RESERVATION', 'ATT_SOFT', 'OPEN']
export function primary(entries: Entry[]): Entry {
  return [...entries].sort((a, b) => KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind))[0]
}

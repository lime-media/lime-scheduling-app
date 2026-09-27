/**
 * Ops planner — the pivot behind the Planner tab.
 *
 * Every truck-day in the window gets one entry per thing on it: a scheduled
 * shift (with its hours and driver), maintenance, a reservation, a committed
 * reservation, a client hold request, an AT&T soft hold, or nothing (open).
 * The pivot then groups those entries by truck, driver, client, campaign or
 * market.
 * A row is always one truck; grouping only adds the headers above it, so every
 * cell is a plain 8, 10 or 12 (or "R" for a reservation with no hours on file).
 *
 * Pure: the API route loads the data and passes it in.
 */

export type EntryKind = 'SCHEDULED' | 'MAINTENANCE' | 'COMMITTED' | 'RESERVATION' | 'REQUEST' | 'ATT_SOFT' | 'OPEN'

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

export type PlannerRow = { truck: string; cells: Record<string, Entry[]> }
export type PlannerGroup = { key: string; label: string; unclassified: boolean; rows: PlannerRow[] }

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
    const kind: EntryKind = h.status === 'COMMITTED' ? 'COMMITTED' : h.source === 'CLIENT' ? 'REQUEST' : 'RESERVATION'
    for (let d = h.start < days[0] ? days[0] : h.start; d <= h.end && d <= days[days.length - 1]; d = addDays(d, 1)) {
      push({
        kind, truck: h.truck, date: d,
        hours: h.hours,
        driver: null,
        client: h.client || 'No client',
        campaign: reservationCampaign(h),
        market: normalizeMarket(h.market),
        barKey: `H|${h.id}`,
        detail: [kind === 'COMMITTED' ? 'Committed (won)' : kind === 'REQUEST' ? 'Client request' : 'Reservation', h.market, h.client].filter(Boolean).join(' · '),
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

/** The group an entry falls under for a pivot. */
export function groupOf(e: Entry, pivot: Pivot): { key: string; unclassified: boolean } {
  switch (pivot) {
    case 'truck': return { key: 'Fleet', unclassified: false }
    case 'driver':
      // Only scheduled shifts carry a driver; everything else is unclassified.
      return e.driver ? { key: e.driver, unclassified: false } : { key: e.kind === 'OPEN' ? OPEN_CAPACITY : UNCLASSIFIED, unclassified: true }
    case 'client': return { key: e.client, unclassified: e.kind === 'OPEN' }
    case 'campaign': return { key: e.campaign, unclassified: e.kind === 'OPEN' }
    case 'market':
      // AT&T soft holds (and the odd reservation) carry no market.
      if (e.kind === 'OPEN') return { key: OPEN_CAPACITY, unclassified: true }
      return e.market ? { key: e.market, unclassified: false } : { key: UNCLASSIFIED, unclassified: true }
  }
}

/**
 * Group entries for a pivot. Each group's rows are the trucks with anything in
 * that group, one row per truck, sorted by truck number; each row's cells hold
 * only that group's entries. Groups sort by name, with unclassified and open
 * capacity last.
 */
export function pivotEntries(entries: Entry[], pivot: Pivot, kinds?: Set<EntryKind>): PlannerGroup[] {
  const groups = new Map<string, { unclassified: boolean; rows: Map<string, PlannerRow> }>()
  for (const e of entries) {
    if (kinds && !kinds.has(e.kind)) continue
    const g = groupOf(e, pivot)
    let group = groups.get(g.key)
    if (!group) { group = { unclassified: g.unclassified, rows: new Map() }; groups.set(g.key, group) }
    let row = group.rows.get(e.truck)
    if (!row) { row = { truck: e.truck, cells: {} }; group.rows.set(e.truck, row) }
    ;(row.cells[e.date] ??= []).push(e)
  }
  const rank = (k: string, u: boolean) => (k === OPEN_CAPACITY ? 2 : u ? 1 : 0)
  return [...groups.entries()]
    .map(([key, g]) => ({ key, label: key, unclassified: g.unclassified, rows: [...g.rows.values()].sort((a, b) => a.truck.localeCompare(b.truck)) }))
    .sort((a, b) => rank(a.key, a.unclassified) - rank(b.key, b.unclassified) || a.label.localeCompare(b.label))
}

/** What a cell shows: hours, or "R" for a reservation with no hours on file; empty for open and non-hour entries. */
export function cellText(e: Entry): string {
  if (e.hours !== null) return String(e.hours)
  if (e.kind === 'RESERVATION' || e.kind === 'COMMITTED' || e.kind === 'REQUEST') return 'R'
  if (e.kind === 'MAINTENANCE') return 'M'
  return ''
}

/** The entry a cell is coloured by when several share it: real work first. */
export const KIND_PRIORITY: EntryKind[] = ['SCHEDULED', 'MAINTENANCE', 'COMMITTED', 'RESERVATION', 'REQUEST', 'ATT_SOFT', 'OPEN']
export function primary(entries: Entry[]): Entry {
  return [...entries].sort((a, b) => KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind))[0]
}

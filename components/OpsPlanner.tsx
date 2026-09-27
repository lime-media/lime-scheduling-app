'use client'

/**
 * Ops planner — a pivotable Gantt of the fleet: last week through six weeks
 * out, every truck's scheduled shifts, maintenance, reservations (client hold
 * requests included), committed reservations, AT&T soft holds and open days.
 *
 * Each pivot is a tree (PIVOT_LEVELS in lib/planner/build.ts):
 *   Truck    → Driver                 (bars labelled with the market)
 *   Driver   → Campaign → Market → Truck
 *   Client   → Campaign → Market → Asset
 *   Campaign → Market → Asset → Driver
 *   Market   → Truck → Campaign
 * The last level is the row with the day cells, showing the shift's 8 / 10 /
 * 12 ("R" for a reservation with no hours on file). Reservations have no
 * driver, so they show as Unassigned / Unclassified at the driver level.
 *
 * Colours are the schedule grid's (lib/statusColors.ts).
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  cellText, leaves, marketLabel, pivotTree, primary,
  type Dimension, type Entry, type EntryKind, type Pivot, type PlannerNode,
} from '@/lib/planner/build'

type PlannerData = {
  window: { from: string; to: string; days: string[] }
  trucks: string[]
  entries: Entry[]
  meta: { driverSource: string | null; driversNamed: number; driversSeen: number; opportunitiesNamed: number; opportunitiesSeen: number }
}

const KIND: Record<EntryKind, { label: string; cell: string; text: string; swatch: string }> = {
  SCHEDULED:   { label: 'Scheduled',       cell: 'bg-gray-300',   text: 'text-gray-800',   swatch: 'bg-gray-300' },
  MAINTENANCE: { label: 'Maintenance',     cell: 'bg-orange-400', text: 'text-white',      swatch: 'bg-orange-400' },
  COMMITTED:   { label: 'Committed (won)', cell: 'bg-gray-200 ring-1 ring-inset ring-gray-300', text: 'text-gray-700', swatch: 'bg-gray-200 ring-1 ring-inset ring-gray-300' },
  RESERVATION: { label: 'Reservation',     cell: 'bg-yellow-400', text: 'text-yellow-950', swatch: 'bg-yellow-400' },
  ATT_SOFT:    { label: 'AT&T soft hold',  cell: 'bg-blue-400',   text: 'text-white',      swatch: 'bg-blue-400' },
  OPEN:        { label: 'Open',            cell: 'bg-green-500',  text: 'text-white',      swatch: 'bg-green-500' },
}
const KIND_ORDER: EntryKind[] = ['SCHEDULED', 'MAINTENANCE', 'COMMITTED', 'RESERVATION', 'ATT_SOFT', 'OPEN']

const PIVOTS: { value: Pivot; label: string; path: string }[] = [
  { value: 'truck',    label: 'Truck',    path: 'Truck › Driver' },
  { value: 'driver',   label: 'Driver',   path: 'Driver › Campaign › Market › Truck' },
  { value: 'client',   label: 'Client',   path: 'Client › Campaign › Market › Asset' },
  { value: 'campaign', label: 'Campaign', path: 'Campaign › Market › Asset › Driver' },
  { value: 'market',   label: 'Market',   path: 'Market › Truck › Campaign' },
]

const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (d: string, n: number) => iso(new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5))
const dow = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay()
const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { ...o, timeZone: 'UTC' })
const localToday = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}` }
const label = (dim: Dimension, value: string) => (dim === 'truck' && /^\d/.test(value) ? `#${value}` : value)

function store<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback } catch { return fallback }
}
function save(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* per-viewer convenience only */ } }

const CELL_W = 34
const LABEL_W = 240
const INDENT = 14

export function OpsPlanner() {
  const today = localToday()
  const [weekOffset, setWeekOffset] = useState(0)
  const [data, setData] = useState<PlannerData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pivot, setPivot] = useState<Pivot>('truck')
  const [kinds, setKinds] = useState<Set<EntryKind>>(new Set(KIND_ORDER))
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [hover, setHover] = useState<{ x: number; y: number; title: string; date: string; entries: Entry[] } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => { setPivot(store<Pivot>('planner.pivot', 'truck')) }, [])
  useEffect(() => { save('planner.pivot', pivot); setCollapsed(new Set()) }, [pivot])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      // The window starts the Monday of last week; shifting it moves by whole weeks.
      const monday = addDays(today, -((dow(today) + 6) % 7) - 7 + weekOffset * 7)
      const res = await fetch(`/api/planner${weekOffset === 0 ? '' : `?from=${monday}`}`)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'The planner could not be loaded.')
      setData(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The planner could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [today, weekOffset])
  useEffect(() => { load() }, [load])

  // Scroll so today sits near the left edge.
  useEffect(() => {
    if (!data || !scroller.current) return
    const i = data.window.days.indexOf(today)
    if (i > 3) scroller.current.scrollLeft = (i - 3) * CELL_W
  }, [data, today])

  const tree = useMemo(() => {
    if (!data) return []
    const all = pivotTree(data.entries, pivot, kinds)
    const q = search.trim().toLowerCase()
    if (!q) return all
    // Keep any node whose own label, or any label beneath it, matches.
    const keep = (n: PlannerNode): PlannerNode | null => {
      if (label(n.dim, n.value).toLowerCase().includes(q)) return n
      const kids = n.children.map(keep).filter((x): x is PlannerNode => x !== null)
      return kids.length ? { ...n, children: kids } : null
    }
    return all.map(keep).filter((x): x is PlannerNode => x !== null)
  }, [data, pivot, kinds, search])

  const days = useMemo(() => data?.window.days ?? [], [data])
  const weeks = useMemo(() => {
    const w: { start: string; span: number }[] = []
    for (let i = 0; i < days.length; i += 7) w.push({ start: days[i], span: Math.min(7, days.length - i) })
    return w
  }, [days])

  const counts = useMemo(() => {
    const c = new Map<EntryKind, number>()
    for (const e of data?.entries ?? []) c.set(e.kind, (c.get(e.kind) ?? 0) + 1)
    return c
  }, [data])

  // Every branch below the top level, for "Top level only".
  const innerBranches = useMemo(() => {
    const out: string[] = []
    const walk = (n: PlannerNode) => { if (n.children.length) { if (n.depth > 0) out.push(n.key); n.children.forEach(walk) } }
    tree.forEach(walk)
    return out
  }, [tree])
  const toggleKind = (k: EntryKind) => setKinds(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const toggleNode = (k: string) => setCollapsed(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const topCollapsed = tree.length > 0 && tree.every(n => collapsed.has(n.key))

  const showMarket = pivot === 'truck'
  const pivotInfo = PIVOTS.find(p => p.value === pivot)!

  const dayBorder = (d: string) => `${dow(d) === 0 ? 'border-r border-r-gray-200' : ''} ${d === today ? 'border-l-2 border-l-gray-900' : ''}`

  // ── Rows ───────────────────────────────────────────────────────────────────

  const renderBranch = (n: PlannerNode): JSX.Element => {
    const isCollapsed = collapsed.has(n.key)
    const top = n.depth === 0
    const truckStrip = n.dim === 'truck'
    const leafRows = leaves(n)
    const bg = top ? 'bg-gray-100' : 'bg-gray-50'
    return (
      <Fragment key={n.key}>
        <tr>
          <td className={`sticky left-0 z-20 border-b border-r border-gray-200 py-1 pr-2 ${bg}`}
            style={{ paddingLeft: 8 + n.depth * INDENT, width: LABEL_W, minWidth: LABEL_W, maxWidth: LABEL_W }}>
            <button onClick={() => toggleNode(n.key)} className="flex items-center gap-1.5 w-full text-left" aria-expanded={!isCollapsed}>
              <span className={`text-gray-400 text-[9px] transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>▶</span>
              <span className={`truncate ${top ? 'font-semibold' : 'font-medium'} ${n.unclassified ? 'italic text-gray-500' : 'text-gray-800'} ${n.dim === 'truck' ? 'tabular-nums' : ''}`} title={label(n.dim, n.value)}>
                {label(n.dim, n.value)}
              </span>
              <span className="ml-auto text-[10px] text-gray-400 tabular-nums">{leafRows.length}</span>
            </button>
          </td>
          {days.map(d => {
            if (truckStrip) {
              // A truck's own row: a thin strip of what it is doing each day.
              const all = leafRows.flatMap(l => l.cells[d] ?? [])
              const e = all.length ? primary(all) : null
              return (
                <td key={d} className={`border-b border-gray-200 ${bg} ${dayBorder(d)} px-0`}>
                  {e && <div className={`h-1.5 mx-px rounded-sm ${KIND[e.kind].cell} ${d < today ? 'opacity-60' : ''}`} />}
                </td>
              )
            }
            const count = n.trucksByDay[d] ?? 0
            return (
              <td key={d} className={`border-b border-gray-200 ${bg} ${dayBorder(d)} text-center text-[10px] tabular-nums ${d === today ? 'text-gray-900 font-semibold' : 'text-gray-400'}`}
                title={count ? `${count} truck${count === 1 ? '' : 's'}` : undefined}>
                {count || ''}
              </td>
            )
          })}
        </tr>
        {!isCollapsed && n.children.map(c => (c.children.length ? renderBranch(c) : renderLeaf(c, n)))}
      </Fragment>
    )
  }

  const renderLeaf = (n: PlannerNode, parent: PlannerNode | null): JSX.Element => {
    const joinKey = (e: Entry) => (showMarket ? `${e.kind}|${marketLabel(e)}` : e.barKey)
    const title = [parent ? label(parent.dim, parent.value) : null, label(n.dim, n.value)].filter(Boolean).join(' · ')
    return (
      <tr key={n.key}>
        <td className="sticky left-0 z-10 bg-white border-b border-r border-gray-100 h-7 pr-2 whitespace-nowrap"
          style={{ paddingLeft: 8 + n.depth * INDENT + 14, width: LABEL_W, minWidth: LABEL_W, maxWidth: LABEL_W }}>
          <span className={`block truncate ${n.unclassified ? 'italic text-gray-500' : 'text-gray-800'} ${n.dim === 'truck' ? 'font-medium tabular-nums' : ''}`} title={label(n.dim, n.value)}>
            {label(n.dim, n.value)}
          </span>
        </td>
        {days.map((d, i) => {
          const list = n.cells[d]
          const weekend = dow(d) === 0 || dow(d) === 6
          const base = `border-b border-gray-100 p-0 ${dayBorder(d)} ${weekend ? 'bg-gray-50' : 'bg-white'}`
          if (!list?.length) return <td key={d} className={base} />
          const e = primary(list)
          const prev = n.cells[days[i - 1]]
          const next = n.cells[days[i + 1]]
          const joinL = !!prev?.length && joinKey(primary(prev)) === joinKey(e)
          const joinR = !!next?.length && joinKey(primary(next)) === joinKey(e)
          // Under the truck pivot, a bar carries the market once, spanning its days.
          let span = 1
          if (showMarket && !joinL) {
            while (i + span < days.length && n.cells[days[i + span]]?.length && joinKey(primary(n.cells[days[i + span]])) === joinKey(e)) span++
          }
          const k = KIND[e.kind]
          return (
            <td key={d} className={base}
              onMouseEnter={ev => setHover({ x: ev.clientX, y: ev.clientY, title, date: d, entries: list })}
              onMouseMove={ev => setHover(h => (h ? { ...h, x: ev.clientX, y: ev.clientY } : h))}>
              <div className={`relative h-5 my-1 flex items-center justify-center font-semibold tabular-nums ${k.cell} ${k.text} ${d < today ? 'opacity-60' : ''}
                ${joinL ? '' : 'ml-0.5 rounded-l'} ${joinR ? '' : 'mr-0.5 rounded-r'}`}>
                {showMarket
                  ? (!joinL && marketLabel(e) && (
                      <span className="absolute left-1 top-0 bottom-0 z-[5] flex items-center text-[10px] font-medium whitespace-nowrap overflow-hidden text-ellipsis pointer-events-none"
                        style={{ width: span * CELL_W - 8 }}>
                        {marketLabel(e)}
                      </span>
                    ))
                  : cellText(e)}
                {list.length > 1 && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-red-500 ring-1 ring-white" title="More than one thing on this day" />}
              </div>
            </td>
          )
        })}
      </tr>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-gray-50">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-white border-b border-gray-200">
        <h1 className="text-lg font-bold text-gray-900 mr-2">Planner</h1>

        <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5" role="tablist" aria-label="Pivot by">
          {PIVOTS.map(p => (
            <button key={p.value} role="tab" aria-selected={pivot === p.value} onClick={() => setPivot(p.value)} title={p.path}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${pivot === p.value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
              {p.label}
            </button>
          ))}
        </div>

        <div className="inline-flex items-center rounded-lg border border-gray-200 bg-white">
          <button onClick={() => setWeekOffset(o => o - 1)} className="px-2.5 py-1.5 text-gray-500 hover:text-gray-900" aria-label="Previous week">‹</button>
          <button onClick={() => setWeekOffset(0)} className="px-2 py-1.5 text-sm font-medium text-gray-700 hover:text-gray-900 border-x border-gray-200">
            {days.length ? `${fmt(days[0], { month: 'short', day: 'numeric' })} – ${fmt(days[days.length - 1], { month: 'short', day: 'numeric' })}` : '…'}
          </button>
          <button onClick={() => setWeekOffset(o => o + 1)} className="px-2.5 py-1.5 text-gray-500 hover:text-gray-900" aria-label="Next week">›</button>
        </div>
        {weekOffset !== 0 && <button onClick={() => setWeekOffset(0)} className="text-sm text-green-700 hover:text-green-800">Back to this week</button>}

        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search trucks, drivers, clients, campaigns, markets…"
          className="ml-auto w-72 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent" />
        {innerBranches.length > 0 && (
          <button onClick={() => setCollapsed(new Set(innerBranches))}
            className="text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-1.5 bg-white" title="Open the first level only">
            Top level only
          </button>
        )}
        <button onClick={() => setCollapsed(topCollapsed ? new Set() : new Set(tree.map(n => n.key)))}
          className="text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-1.5 bg-white">
          {topCollapsed ? 'Expand all' : 'Collapse all'}
        </button>
      </div>

      {/* Legend = filters */}
      <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 bg-white border-b border-gray-200">
        {KIND_ORDER.map(k => (
          <button key={k} onClick={() => toggleKind(k)} aria-pressed={kinds.has(k)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${kinds.has(k) ? 'bg-white border-gray-300 text-gray-800' : 'bg-gray-50 border-gray-200 text-gray-400'}`}>
            <span className={`w-3 h-3 rounded-sm ${KIND[k].swatch} ${kinds.has(k) ? '' : 'opacity-30'}`} />
            {KIND[k].label}
            <span className="text-gray-400 tabular-nums">{(counts.get(k) ?? 0).toLocaleString()}</span>
          </button>
        ))}
        <span className="ml-auto text-xs text-gray-400">
          {showMarket ? 'Bars show the market the truck is in' : 'Cells show scheduled hours · R = reservation, hours not on file · M = maintenance'} · numbers on group rows = trucks that day
        </span>
      </div>

      {data && data.meta.driversSeen > 0 && data.meta.driversNamed === 0 && (
        <div className="px-4 py-2 text-xs text-amber-800 bg-amber-50 border-b border-amber-200">
          Driver names could not be found{data.meta.driverSource ? ` in ${data.meta.driverSource}` : ''}; drivers are shown by id.
        </div>
      )}

      {/* Grid */}
      <div ref={scroller} className="flex-1 min-h-0 overflow-auto relative" onMouseLeave={() => setHover(null)}>
        {loading && !data && <div className="p-8 text-sm text-gray-500">Loading the planner…</div>}
        {error && <div className="m-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">{error} <button onClick={load} className="underline ml-2">Retry</button></div>}
        {data && (
          <table className="border-separate border-spacing-0 text-xs select-none" style={{ minWidth: LABEL_W + days.length * CELL_W }}>
            <thead className="sticky top-0 z-30">
              <tr>
                <th rowSpan={2} className="sticky left-0 z-40 bg-white border-b border-r border-gray-200 text-left px-3 font-semibold text-gray-700 whitespace-nowrap"
                  style={{ width: LABEL_W, minWidth: LABEL_W }}>
                  {pivotInfo.path}
                </th>
                {weeks.map(w => (
                  <th key={w.start} colSpan={w.span} className="bg-white border-b border-r border-gray-200 px-2 py-1 text-left font-semibold text-gray-700 whitespace-nowrap">
                    Week of {fmt(w.start, { month: 'short', day: 'numeric' })}
                  </th>
                ))}
              </tr>
              <tr>
                {days.map(d => {
                  const weekend = dow(d) === 0 || dow(d) === 6
                  return (
                    <th key={d} style={{ width: CELL_W, minWidth: CELL_W }}
                      className={`border-b border-gray-200 ${dow(d) === 0 ? 'border-r' : ''} py-1 font-medium ${d === today ? 'bg-gray-900 text-white' : weekend ? 'bg-gray-100 text-gray-500' : 'bg-white text-gray-600'}`}>
                      <div className="leading-none text-[10px] uppercase">{fmt(d, { weekday: 'narrow' })}</div>
                      <div className="leading-tight tabular-nums">{fmt(d, { day: 'numeric' })}</div>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {tree.length === 0 && (
                <tr><td colSpan={days.length + 1} className="p-8 text-center text-sm text-gray-500">Nothing matches.</td></tr>
              )}
              {tree.map(n => (n.children.length ? renderBranch(n) : renderLeaf(n, null)))}
            </tbody>
          </table>
        )}
      </div>

      {/* Hover card */}
      {hover && (
        <div className="fixed z-50 pointer-events-none bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-xs w-64"
          style={{ left: Math.min(hover.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 270), top: hover.y + 14 }}>
          <div className="font-semibold text-gray-900">{fmt(hover.date, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
          <div className="text-gray-500 truncate">{hover.title}</div>
          {hover.entries.map((e, i) => (
            <div key={i} className="mt-1.5 flex gap-2">
              <span className={`mt-0.5 w-2.5 h-2.5 rounded-sm flex-shrink-0 ${KIND[e.kind].swatch}`} />
              <div className="min-w-0">
                <div className="font-medium text-gray-800">
                  #{e.truck} · {KIND[e.kind].label}{e.hours !== null ? ` · ${e.hours} hrs` : e.kind === 'RESERVATION' || e.kind === 'COMMITTED' ? ' · hours not on file' : ''}
                </div>
                {e.kind !== 'OPEN' && <div className="text-gray-500 truncate">{e.campaign}</div>}
                {e.kind !== 'OPEN' && <div className="text-gray-500 truncate">{[e.client, e.market].filter(Boolean).join(' · ')}</div>}
                {e.driver && <div className="text-gray-500">Driver: {e.driver}</div>}
                {e.detail.includes('client request') && <div className="text-gray-500">From a client hold request</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

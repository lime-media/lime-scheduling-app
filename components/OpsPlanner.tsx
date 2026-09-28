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
 * 12 — R for a reservation and C for a committed reservation with no hours on
 * file, M for maintenance.
 *
 * Colours and labels come only from lib/statusColors.ts.
 *
 * Performance: the grid is a memoised component, so the hover card (its own
 * component, with its own state) and typing in search never re-render the
 * ~3,500 cells. The pivot is computed once per data/pivot/filter change and
 * each cell's display entry is precomputed there, not per render.
 */

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import {
  cellText, describeEntry, entryMatches, marketLabel, pivotTree, truckDayTop,
  type Dimension, type Entry, type EntryKind, type Pivot, type PlannerNode,
} from '@/lib/planner/build'
import {
  LEGEND_SWATCH, CELL_TEXT, RESERVATION_LABEL, COMMITTED_LABEL, ATT_SOFT_LABEL, type DisplayStatus,
} from '@/lib/statusColors'

type PlannerData = {
  window: { from: string; to: string; days: string[] }
  trucks: string[]
  entries: Entry[]
  meta: { driverSource: string | null; driversNamed: number; driversSeen: number; opportunitiesNamed: number; opportunitiesSeen: number }
}

// Planner kinds are the grid's statuses; colours and labels come from the shared palette.
const STATUS_OF: Record<EntryKind, DisplayStatus> = {
  SCHEDULED: 'SCHEDULED_LED', MAINTENANCE: 'MAINTENANCE', COMMITTED: 'COMMITTED_NOT_SET',
  RESERVATION: 'HOLD_TENTATIVE', ATT_SOFT: 'ATT_SOFT', OPEN: 'EMPTY',
}
const KIND_LABEL: Record<EntryKind, string> = {
  SCHEDULED: 'Scheduled', MAINTENANCE: 'Maintenance', COMMITTED: COMMITTED_LABEL,
  RESERVATION: RESERVATION_LABEL, ATT_SOFT: ATT_SOFT_LABEL, OPEN: 'Open',
}
const swatch = (k: EntryKind) => LEGEND_SWATCH[STATUS_OF[k] as keyof typeof LEGEND_SWATCH]
const textOn = (k: EntryKind) => CELL_TEXT[STATUS_OF[k]]
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
const dowOf = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay()
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
const WEEKS = 8

type DayMeta = { d: string; weekend: boolean; sunday: boolean; past: boolean; today: boolean; header: string; num: string }
type HoverInfo = { x: number; y: number; title: string; date: string; entries: Entry[] }
type HoverApi = { show: (h: HoverInfo) => void; move: (x: number, y: number) => void; hide: () => void }

// ─────────────────────────────────────────────────────────────────────────────

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
  const deferredSearch = useDeferredValue(search)
  const hoverApi = useRef<HoverApi | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => { setPivot(store<Pivot>('planner.pivot', 'truck')) }, [])
  useEffect(() => { save('planner.pivot', pivot); setCollapsed(new Set()) }, [pivot])

  // The window the rep asked for, known before the response arrives.
  const requested = useMemo(() => {
    const from = addDays(today, -((dowOf(today) + 6) % 7) - 7 + weekOffset * 7)
    return { from, to: addDays(from, WEEKS * 7 - 1) }
  }, [today, weekOffset])

  // Only the latest request may land: quick clicks on ‹ › abort the earlier ones.
  useEffect(() => {
    const mine = ++seq.current
    const ctrl = new AbortController()
    setLoading(true); setError(null)
    fetch(`/api/planner${weekOffset === 0 ? '' : `?from=${requested.from}`}`, { signal: ctrl.signal })
      .then(async res => {
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || 'The planner could not be loaded.')
        if (mine === seq.current) setData(body)
      })
      .catch(e => { if (mine === seq.current && e?.name !== 'AbortError') setError(e instanceof Error ? e.message : 'The planner could not be loaded.') })
      .finally(() => { if (mine === seq.current) setLoading(false) })
    return () => ctrl.abort()
  }, [weekOffset, requested.from, reloadKey])

  const days = useMemo(() => data?.window.days ?? [], [data])
  const dayMeta = useMemo<DayMeta[]>(() => days.map(d => {
    const dow = dowOf(d)
    return { d, weekend: dow === 0 || dow === 6, sunday: dow === 0, past: d < today, today: d === today, header: fmt(d, { weekday: 'narrow' }), num: fmt(d, { day: 'numeric' }) }
  }), [days, today])
  const weeks = useMemo(() => {
    const w: { start: string; span: number }[] = []
    for (let i = 0; i < days.length; i += 7) w.push({ start: days[i], span: Math.min(7, days.length - i) })
    return w
  }, [days])

  // Pivot once per data / pivot / filter change — never per keystroke.
  const baseTree = useMemo(() => (data ? pivotTree(data.entries, pivot, kinds, data.trucks) : []), [data, pivot, kinds])
  const strips = useMemo(() => (data ? truckDayTop(data.entries, kinds) : new Map<string, Record<string, Entry>>()), [data, kinds])
  const q = deferredSearch.trim().toLowerCase()
  const tree = useMemo(() => {
    if (!q) return baseTree
    const keep = (n: PlannerNode): PlannerNode | null => {
      if (label(n.dim, n.value).toLowerCase().includes(q)) return n
      const kids = n.children.map(keep).filter((x): x is PlannerNode => x !== null)
      return kids.length ? { ...n, children: kids, leafCount: kids.reduce((s, k) => s + k.leafCount, 0) } : null
    }
    return baseTree.map(keep).filter((x): x is PlannerNode => x !== null)
  }, [baseTree, q])

  // Legend counts follow the search, so the numbers describe what is on screen.
  const counts = useMemo(() => {
    const c = new Map<EntryKind, number>()
    for (const e of data?.entries ?? []) if (entryMatches(e, q)) c.set(e.kind, (c.get(e.kind) ?? 0) + 1)
    return c
  }, [data, q])

  const innerBranches = useMemo(() => {
    const out: string[] = []
    const walk = (n: PlannerNode) => { if (n.children.length) { if (n.depth > 0) out.push(n.key); n.children.forEach(walk) } }
    tree.forEach(walk)
    return out
  }, [tree])

  const toggleKind = (k: EntryKind) => setKinds(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const toggleNode = useCallback((k: string) => setCollapsed(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n }), [])
  const topCollapsed = tree.length > 0 && tree.every(n => collapsed.has(n.key))
  const pivotInfo = PIVOTS.find(p => p.value === pivot)!

  // Scroll so today sits near the left edge when a window loads.
  useEffect(() => {
    if (!data || !scroller.current) return
    const i = data.window.days.indexOf(today)
    scroller.current.scrollLeft = i > 3 ? (i - 3) * CELL_W : 0
  }, [data, today])

  const stale = loading && data !== null
  const partialDrivers = data && data.meta.driversSeen > 0 && data.meta.driversNamed < data.meta.driversSeen
  const partialOpps = data && data.meta.opportunitiesSeen > 0 && data.meta.opportunitiesNamed < data.meta.opportunitiesSeen

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
          <button onClick={() => setWeekOffset(0)} className="px-2 py-1.5 text-sm font-medium text-gray-700 hover:text-gray-900 border-x border-gray-200 tabular-nums">
            {fmt(requested.from, { month: 'short', day: 'numeric' })} – {fmt(requested.to, { month: 'short', day: 'numeric' })}
          </button>
          <button onClick={() => setWeekOffset(o => o + 1)} className="px-2.5 py-1.5 text-gray-500 hover:text-gray-900" aria-label="Next week">›</button>
        </div>
        {weekOffset !== 0 && <button onClick={() => setWeekOffset(0)} className="text-sm text-green-700 hover:text-green-800">Back to this week</button>}
        {loading && (
          <span className="inline-flex items-center gap-1.5 text-xs text-gray-500" role="status" aria-live="polite">
            <span className="w-3 h-3 border-2 border-gray-300 border-t-gray-700 rounded-full animate-spin" /> Loading…
          </span>
        )}

        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search trucks, drivers, clients, campaigns, markets…" aria-label="Search the planner"
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
            <span className={`w-3 h-3 rounded-sm ${swatch(k)} ${kinds.has(k) ? '' : 'opacity-30'}`} />
            {KIND_LABEL[k]}
            <span className="text-gray-500 tabular-nums">{(counts.get(k) ?? 0).toLocaleString()}</span>
          </button>
        ))}
        <span className="ml-auto text-xs text-gray-500">
          {pivot === 'truck' ? 'Bars show the market the truck is in' : 'Cells show scheduled hours · R reservation, C committed (hours not on file) · M maintenance'} · numbers on group rows = trucks that day
        </span>
      </div>

      {(partialDrivers || partialOpps) && (
        <div className="px-4 py-2 text-xs text-amber-900 bg-amber-50 border-b border-amber-200 space-y-0.5" role="status">
          {partialDrivers && <div>{data!.meta.driversNamed} of {data!.meta.driversSeen} driver names found{data!.meta.driverSource ? ` in ${data!.meta.driverSource}` : ''}; the rest show as “Driver” plus an id.</div>}
          {partialOpps && <div>{data!.meta.opportunitiesNamed} of {data!.meta.opportunitiesSeen} Salesforce opportunity names found; the rest show as “Opportunity” plus an id.</div>}
        </div>
      )}

      {/* Grid */}
      <div ref={scroller} className={`flex-1 min-h-0 overflow-auto relative transition-opacity ${stale ? 'opacity-50 pointer-events-none' : ''}`}
        onMouseLeave={() => hoverApi.current?.hide()} aria-busy={loading}>
        {loading && !data && <div className="p-8 text-sm text-gray-500">Loading the planner…</div>}
        {error && (
          <div className="m-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
            {error} <button onClick={() => setReloadKey(k => k + 1)} className="underline ml-2">Retry</button>
          </div>
        )}
        {data && (
          <PlannerGrid
            tree={tree} dayMeta={dayMeta} weeks={weeks} collapsed={collapsed} onToggle={toggleNode}
            showMarket={pivot === 'truck'} strips={strips} hoverApi={hoverApi} header={pivotInfo.path}
          />
        )}
      </div>

      <HoverCard apiRef={hoverApi} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Grid — memoised; re-renders only when its data, pivot or collapsed state change.

type GridProps = {
  tree: PlannerNode[]
  dayMeta: DayMeta[]
  weeks: { start: string; span: number }[]
  collapsed: Set<string>
  onToggle: (key: string) => void
  showMarket: boolean
  strips: Map<string, Record<string, Entry>>
  hoverApi: MutableRefObject<HoverApi | null>
  header: string
}

const PlannerGrid = memo(function PlannerGrid({ tree, dayMeta, weeks, collapsed, onToggle, showMarket, strips, hoverApi, header }: GridProps) {
  const tableRef = useRef<HTMLTableElement>(null)
  const dayBorder = (m: DayMeta) => `${m.sunday ? 'border-r border-r-gray-200' : ''} ${m.today ? 'border-l-2 border-l-gray-900' : ''}`
  const joinKey = (e: Entry) => (showMarket ? `${e.kind}|${marketLabel(e)}` : e.barKey)
  let row = 0 // leaf rows, for keyboard navigation

  // Keyboard: one cell is in the tab order at a time (roving tabindex); arrow
  // keys move through the grid, and a focused cell shows its details.
  const onKeyDown = (ev: React.KeyboardEvent) => {
    const cell = (ev.target as HTMLElement).closest('td[data-r]') as HTMLElement | null
    if (!cell || !tableRef.current) return
    const r = Number(cell.dataset.r), c = Number(cell.dataset.c)
    const next = { ArrowRight: [r, c + 1], ArrowLeft: [r, c - 1], ArrowDown: [r + 1, c], ArrowUp: [r - 1, c], Home: [r, 0], End: [r, dayMeta.length - 1] }[ev.key]
    if (!next) { if (ev.key === 'Escape') hoverApi.current?.hide(); return }
    const target = tableRef.current.querySelector<HTMLElement>(`td[data-r="${next[0]}"][data-c="${next[1]}"]`)
    if (!target) return
    ev.preventDefault()
    cell.tabIndex = -1
    target.tabIndex = 0
    target.focus()
  }
  const showFor = (el: HTMLElement, info: Omit<HoverInfo, 'x' | 'y'>) => {
    const r = el.getBoundingClientRect()
    hoverApi.current?.show({ ...info, x: r.right, y: r.bottom })
  }

  const renderLeaf = (n: PlannerNode, parent: PlannerNode | null): JSX.Element => {
    const r = row++
    const title = [parent ? label(parent.dim, parent.value) : null, label(n.dim, n.value)].filter(Boolean).join(' · ')
    return (
      <tr key={n.key}>
        <th scope="row" className="sticky left-0 z-10 bg-white border-b border-r border-gray-100 h-7 pr-2 whitespace-nowrap text-left font-normal"
          style={{ paddingLeft: 8 + n.depth * INDENT + 14, width: LABEL_W, minWidth: LABEL_W, maxWidth: LABEL_W }}>
          <span className={`block truncate ${n.unclassified ? 'italic text-gray-500' : 'text-gray-800'} ${n.dim === 'truck' ? 'font-medium tabular-nums' : ''}`} title={title}>
            {label(n.dim, n.value)}
          </span>
        </th>
        {dayMeta.map((m, i) => {
          const e = n.top[m.d]
          const list = n.cells[m.d]
          const base = `border-b border-gray-100 p-0 ${dayBorder(m)} ${m.weekend ? 'bg-gray-50' : 'bg-white'} focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-inset`
          const aria = `${fmt(m.d, { weekday: 'long', month: 'long', day: 'numeric' })}. ${title}. ${list?.length ? list.map(describeEntry).join('; ') : 'Nothing'}`
          const nav = { 'data-r': r, 'data-c': i, tabIndex: r === 0 && i === 0 ? 0 : -1, 'aria-label': aria }
          if (!e) return <td key={m.d} className={base} {...nav} />
          const prev = n.top[dayMeta[i - 1]?.d]
          const next = n.top[dayMeta[i + 1]?.d]
          const joinL = !!prev && joinKey(prev) === joinKey(e)
          const joinR = !!next && joinKey(next) === joinKey(e)
          // Under the truck pivot, a bar carries the market once, spanning its days.
          let span = 1
          if (showMarket && !joinL) {
            while (i + span < dayMeta.length && n.top[dayMeta[i + span].d] && joinKey(n.top[dayMeta[i + span].d]) === joinKey(e)) span++
          }
          const info = { title, date: m.d, entries: list }
          return (
            <td key={m.d} className={base} {...nav}
              onMouseEnter={ev => hoverApi.current?.show({ ...info, x: ev.clientX, y: ev.clientY })}
              onMouseMove={ev => hoverApi.current?.move(ev.clientX, ev.clientY)}
              onFocus={ev => showFor(ev.currentTarget, info)}
              onBlur={() => hoverApi.current?.hide()}>
              <div aria-hidden className={`relative h-5 my-1 flex items-center justify-center font-semibold tabular-nums ${swatch(e.kind)} ${textOn(e.kind)} ${m.past ? 'opacity-60' : ''}
                ${joinL ? '' : 'ml-0.5 rounded-l'} ${joinR ? '' : 'mr-0.5 rounded-r'}`}>
                {showMarket
                  ? (!joinL && marketLabel(e) && (
                      <span className="absolute left-1 top-0 bottom-0 z-[5] flex items-center text-[10px] font-medium whitespace-nowrap overflow-hidden text-ellipsis pointer-events-none"
                        style={{ width: span * CELL_W - 8 }}>
                        {marketLabel(e)}
                      </span>
                    ))
                  : cellText(e)}
                {list.length > 1 && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-red-500 ring-1 ring-white" />}
              </div>
            </td>
          )
        })}
      </tr>
    )
  }

  const renderBranch = (n: PlannerNode): JSX.Element => {
    const isCollapsed = collapsed.has(n.key)
    const top = n.depth === 0
    const bg = top ? 'bg-gray-100' : 'bg-gray-50'
    // A truck's own row: a thin strip of what the truck is doing across the
    // whole order, not just this group, so it never looks idle when it is busy elsewhere.
    const strip = n.dim === 'truck' ? strips.get(n.value) : undefined
    return (
      <>
        <tr key={n.key}>
          <th scope="rowgroup" className={`sticky left-0 z-20 border-b border-r border-gray-200 py-1 pr-2 text-left font-normal ${bg}`}
            style={{ paddingLeft: 8 + n.depth * INDENT, width: LABEL_W, minWidth: LABEL_W, maxWidth: LABEL_W }}>
            <button onClick={() => onToggle(n.key)} className="flex items-center gap-1.5 w-full text-left" aria-expanded={!isCollapsed}>
              <span aria-hidden className={`text-gray-400 text-[9px] transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>▶</span>
              <span className={`truncate ${top ? 'font-semibold' : 'font-medium'} ${n.unclassified ? 'italic text-gray-500' : 'text-gray-800'} ${n.dim === 'truck' ? 'tabular-nums' : ''}`} title={label(n.dim, n.value)}>
                {label(n.dim, n.value)}
              </span>
              <span className="ml-auto text-[10px] text-gray-500 tabular-nums" aria-label={`${n.leafCount} rows`}>{n.leafCount}</span>
            </button>
          </th>
          {dayMeta.map(m => {
            if (n.dim === 'truck') {
              const e = strip?.[m.d]
              return (
                <td key={m.d} className={`border-b border-gray-200 ${bg} ${dayBorder(m)} px-0`}>
                  {e && <div aria-hidden className={`h-1.5 mx-px rounded-sm ${swatch(e.kind)} ${m.past ? 'opacity-60' : ''}`} />}
                </td>
              )
            }
            const count = n.trucksByDay[m.d] ?? 0
            return (
              <td key={m.d} className={`border-b border-gray-200 ${bg} ${dayBorder(m)} text-center text-[10px] tabular-nums ${m.today ? 'text-gray-900 font-semibold' : 'text-gray-500'}`}
                title={count ? `${count} truck${count === 1 ? '' : 's'}` : undefined}>
                {count || ''}
              </td>
            )
          })}
        </tr>
        {!isCollapsed && n.children.map(c => (c.children.length ? <BranchKey key={c.key}>{renderBranch(c)}</BranchKey> : renderLeaf(c, n)))}
      </>
    )
  }

  return (
    <table ref={tableRef} onKeyDown={onKeyDown} className="border-separate border-spacing-0 text-xs select-none" style={{ minWidth: LABEL_W + dayMeta.length * CELL_W }}
      aria-label={`Planner: ${header}`}>
      <thead className="sticky top-0 z-30">
        <tr>
          <th rowSpan={2} scope="col" className="sticky left-0 z-40 bg-white border-b border-r border-gray-200 text-left px-3 font-semibold text-gray-700 whitespace-nowrap"
            style={{ width: LABEL_W, minWidth: LABEL_W }}>
            {header}
          </th>
          {weeks.map(w => (
            <th key={w.start} colSpan={w.span} scope="colgroup" className="bg-white border-b border-r border-gray-200 px-2 py-1 text-left font-semibold text-gray-700 whitespace-nowrap">
              Week of {fmt(w.start, { month: 'short', day: 'numeric' })}
            </th>
          ))}
        </tr>
        <tr>
          {dayMeta.map(m => (
            <th key={m.d} scope="col" style={{ width: CELL_W, minWidth: CELL_W }} aria-label={fmt(m.d, { weekday: 'long', month: 'long', day: 'numeric' })}
              className={`border-b border-gray-200 ${m.sunday ? 'border-r' : ''} py-1 font-medium ${m.today ? 'bg-gray-900 text-white' : m.weekend ? 'bg-gray-100 text-gray-600' : 'bg-white text-gray-600'}`}>
              <div className="leading-none text-[10px] uppercase">{m.header}</div>
              <div className="leading-tight tabular-nums">{m.num}</div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {tree.length === 0 && (
          <tr><td colSpan={dayMeta.length + 1} className="p-8 text-center text-sm text-gray-500">Nothing matches.</td></tr>
        )}
        {tree.map(n => (n.children.length ? <BranchKey key={n.key}>{renderBranch(n)}</BranchKey> : renderLeaf(n, null)))}
      </tbody>
    </table>
  )
})

/** A keyed wrapper so each branch's rows reconcile as one unit. */
function BranchKey({ children }: { children: JSX.Element }) { return children }

// ─────────────────────────────────────────────────────────────────────────────
// Hover / focus card — its own state, so moving the pointer re-renders only this.

function HoverCard({ apiRef }: { apiRef: MutableRefObject<HoverApi | null> }) {
  const [info, setInfo] = useState<HoverInfo | null>(null)
  useEffect(() => {
    apiRef.current = {
      show: h => setInfo(h),
      move: (x, y) => setInfo(h => (h && (h.x !== x || h.y !== y) ? { ...h, x, y } : h)),
      hide: () => setInfo(null),
    }
    return () => { apiRef.current = null }
  }, [apiRef])
  if (!info) return null
  const W = 264, H = 60 + info.entries.length * 64
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  // Keep the card inside the viewport on both axes: flip above/left when it would overflow.
  const left = info.x + 14 + W > vw ? Math.max(8, info.x - 14 - W) : info.x + 14
  const top = info.y + 14 + H > vh ? Math.max(8, info.y - 14 - H) : info.y + 14
  return (
    <div className="fixed z-50 pointer-events-none bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-xs" style={{ left, top, width: W }} aria-hidden>
      <div className="font-semibold text-gray-900">{fmt(info.date, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
      <div className="text-gray-500 truncate">{info.title}</div>
      {info.entries.map((e, i) => (
        <div key={i} className="mt-1.5 flex gap-2">
          <span className={`mt-0.5 w-2.5 h-2.5 rounded-sm flex-shrink-0 ${swatch(e.kind)}`} />
          <div className="min-w-0">
            <div className="font-medium text-gray-800">
              #{e.truck} · {KIND_LABEL[e.kind]}{e.hours !== null ? ` · ${e.hours} hrs` : e.kind === 'RESERVATION' || e.kind === 'COMMITTED' ? ' · hours not on file' : ''}
            </div>
            {e.kind !== 'OPEN' && <div className="text-gray-500 truncate">{e.campaign}</div>}
            {e.kind !== 'OPEN' && <div className="text-gray-500 truncate">{[e.client, e.market].filter(Boolean).join(' · ')}</div>}
            {e.driver && <div className="text-gray-500">Driver: {e.driver}</div>}
            {e.detail.includes('client request') && <div className="text-gray-500">From a client hold request</div>}
          </div>
        </div>
      ))}
    </div>
  )
}

'use client'

/**
 * Ops planner — a pivotable Gantt of the fleet: last week through six weeks
 * out, every truck's scheduled shifts (with hours), maintenance, reservations,
 * committed reservations, client requests, AT&T soft holds and open days.
 *
 * Pivot by truck, driver, client or campaign. A row is always one truck;
 * grouping only adds the header above it, so every cell is a plain 8, 10 or
 * 12 — or "R" for a reservation with no hours on file. Reservations have no
 * driver, so under the driver pivot they sit in Unclassified.
 *
 * Colours are the schedule grid's (lib/statusColors.ts): green is open,
 * slate scheduled, yellow reservation, soft green committed (won), blue AT&T
 * soft hold, orange maintenance.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cellText, pivotEntries, primary, type Entry, type EntryKind, type Pivot } from '@/lib/planner/build'

type PlannerData = {
  window: { from: string; to: string; days: string[] }
  trucks: string[]
  entries: Entry[]
  meta: { driverSource: string | null; driversNamed: number; driversSeen: number; opportunitiesNamed: number; opportunitiesSeen: number }
}

const KIND: Record<EntryKind, { label: string; cell: string; text: string; swatch: string }> = {
  SCHEDULED:   { label: 'Scheduled',       cell: 'bg-slate-500',  text: 'text-white',      swatch: 'bg-slate-500' },
  MAINTENANCE: { label: 'Maintenance',     cell: 'bg-orange-400', text: 'text-white',      swatch: 'bg-orange-400' },
  COMMITTED:   { label: 'Committed (won)', cell: 'bg-green-200',  text: 'text-green-900',  swatch: 'bg-green-200' },
  RESERVATION: { label: 'Reservation',     cell: 'bg-yellow-400', text: 'text-yellow-950', swatch: 'bg-yellow-400' },
  REQUEST:     { label: 'Client request',  cell: 'bg-yellow-200', text: 'text-yellow-900', swatch: 'bg-yellow-200' },
  ATT_SOFT:    { label: 'AT&T soft hold',  cell: 'bg-blue-400',   text: 'text-white',      swatch: 'bg-blue-400' },
  OPEN:        { label: 'Open',            cell: 'bg-green-500',  text: 'text-white',      swatch: 'bg-green-500' },
}
const KIND_ORDER: EntryKind[] = ['SCHEDULED', 'MAINTENANCE', 'COMMITTED', 'RESERVATION', 'REQUEST', 'ATT_SOFT', 'OPEN']

const PIVOTS: { value: Pivot; label: string }[] = [
  { value: 'truck', label: 'Truck' },
  { value: 'driver', label: 'Driver' },
  { value: 'client', label: 'Client' },
  { value: 'campaign', label: 'Campaign' },
]

const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (d: string, n: number) => iso(new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5))
const dow = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay()
const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { ...o, timeZone: 'UTC' })
const localToday = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}` }

function store<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback } catch { return fallback }
}
function save(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* per-viewer convenience only */ } }

const CELL_W = 34

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
  const [hover, setHover] = useState<{ x: number; y: number; truck: string; date: string; entries: Entry[] } | null>(null)
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

  // Scroll so today sits near the left edge, after the header row.
  useEffect(() => {
    if (!data || !scroller.current) return
    const i = data.window.days.indexOf(today)
    if (i > 3) scroller.current.scrollLeft = (i - 3) * CELL_W
  }, [data, today])

  const groups = useMemo(() => {
    if (!data) return []
    const all = pivotEntries(data.entries, pivot, kinds)
    const q = search.trim().toLowerCase()
    if (!q) return all
    return all
      .map(g => (g.label.toLowerCase().includes(q) ? g : { ...g, rows: g.rows.filter(r => r.truck.toLowerCase().includes(q)) }))
      .filter(g => g.rows.length > 0)
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

  const toggleKind = (k: EntryKind) => setKinds(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const toggleGroup = (k: string) => setCollapsed(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const allCollapsed = groups.length > 0 && groups.every(g => collapsed.has(g.key))

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-gray-50">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-white border-b border-gray-200">
        <h1 className="text-lg font-bold text-gray-900 mr-2">Planner</h1>

        <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5" role="tablist" aria-label="Pivot by">
          {PIVOTS.map(p => (
            <button key={p.value} role="tab" aria-selected={pivot === p.value} onClick={() => setPivot(p.value)}
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

        <input value={search} onChange={e => setSearch(e.target.value)} placeholder={`Search ${pivot === 'truck' ? 'trucks' : `${pivot}s or trucks`}…`}
          className="ml-auto w-56 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent" />
        <button onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map(g => g.key)))}
          className="text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-1.5 bg-white">
          {allCollapsed ? 'Expand all' : 'Collapse all'}
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
        <span className="ml-auto text-xs text-gray-400">Cells show scheduled hours · R = reservation, hours not on file · M = maintenance</span>
      </div>

      {data && (data.meta.driversSeen > 0 && data.meta.driversNamed === 0) && (
        <div className="px-4 py-2 text-xs text-amber-800 bg-amber-50 border-b border-amber-200">
          Driver names could not be found{data.meta.driverSource ? ` in ${data.meta.driverSource}` : ''}; drivers are shown by id.
        </div>
      )}

      {/* Grid */}
      <div ref={scroller} className="flex-1 min-h-0 overflow-auto relative" onMouseLeave={() => setHover(null)}>
        {loading && !data && <div className="p-8 text-sm text-gray-500">Loading the planner…</div>}
        {error && <div className="m-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">{error} <button onClick={load} className="underline ml-2">Retry</button></div>}
        {data && (
          <table className="border-separate border-spacing-0 text-xs select-none" style={{ minWidth: 200 + days.length * CELL_W }}>
            <thead className="sticky top-0 z-30">
              <tr>
                <th rowSpan={2} className="sticky left-0 z-40 bg-white border-b border-r border-gray-200 w-[200px] min-w-[200px] text-left px-3 font-semibold text-gray-700">
                  {PIVOTS.find(p => p.value === pivot)!.label} / Truck
                </th>
                {weeks.map(w => (
                  <th key={w.start} colSpan={w.span} className="bg-white border-b border-r border-gray-200 px-2 py-1 text-left font-semibold text-gray-700 whitespace-nowrap">
                    Week of {fmt(w.start, { month: 'short', day: 'numeric' })}
                  </th>
                ))}
              </tr>
              <tr>
                {days.map(d => {
                  const isToday = d === today
                  const weekend = dow(d) === 0 || dow(d) === 6
                  return (
                    <th key={d} style={{ width: CELL_W, minWidth: CELL_W }}
                      className={`border-b border-gray-200 ${dow(d) === 0 ? 'border-r' : ''} py-1 font-medium ${isToday ? 'bg-gray-900 text-white' : weekend ? 'bg-gray-100 text-gray-500' : 'bg-white text-gray-600'}`}>
                      <div className="leading-none text-[10px] uppercase">{fmt(d, { weekday: 'narrow' })}</div>
                      <div className="leading-tight tabular-nums">{fmt(d, { day: 'numeric' })}</div>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 && (
                <tr><td colSpan={days.length + 1} className="p-8 text-center text-sm text-gray-500">Nothing matches.</td></tr>
              )}
              {groups.map(g => {
                const isCollapsed = collapsed.has(g.key)
                return (
                  <Fragment key={g.key}>
                    {pivot !== 'truck' && (
                      <tr className="group/g">
                        <td className="sticky left-0 z-20 bg-gray-100 border-b border-r border-gray-200 px-2 py-1.5">
                          <button onClick={() => toggleGroup(g.key)} className="flex items-center gap-1.5 w-full text-left" aria-expanded={!isCollapsed}>
                            <span className={`text-gray-400 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>▸</span>
                            <span className={`font-semibold truncate ${g.unclassified ? 'text-gray-500 italic' : 'text-gray-800'}`} title={g.label}>{g.label}</span>
                            <span className="ml-auto text-[11px] text-gray-400 tabular-nums">{g.rows.length}</span>
                          </button>
                        </td>
                        {days.map(d => {
                          // Trucks with anything in this group that day.
                          const n = g.rows.filter(r => r.cells[d]?.length).length
                          return (
                            <td key={d} className={`bg-gray-100 border-b border-gray-200 ${dow(d) === 0 ? 'border-r' : ''} text-center text-[10px] tabular-nums ${d === today ? 'text-gray-900 font-semibold' : 'text-gray-400'}`}>
                              {n || ''}
                            </td>
                          )
                        })}
                      </tr>
                    )}
                    {!isCollapsed && g.rows.map(r => (
                      <tr key={r.truck} className="hover:[&>td]:bg-gray-50/0">
                        <td className="sticky left-0 z-10 bg-white border-b border-r border-gray-100 px-3 py-0 h-7 font-medium text-gray-800 tabular-nums whitespace-nowrap">
                          <span className={pivot === 'truck' ? '' : 'pl-4'}>#{r.truck}</span>
                        </td>
                        {days.map((d, i) => {
                          const list = r.cells[d]
                          const weekend = dow(d) === 0 || dow(d) === 6
                          const past = d < today
                          const border = `border-b border-gray-100 ${dow(d) === 0 ? 'border-r border-r-gray-200' : ''} ${d === today ? 'border-l-2 border-l-gray-900' : ''}`
                          if (!list?.length) {
                            return <td key={d} className={`${border} ${weekend ? 'bg-gray-50' : 'bg-white'}`} />
                          }
                          const e = primary(list)
                          // Join consecutive days of the same thing into one bar.
                          const prev = r.cells[days[i - 1]]
                          const next = r.cells[days[i + 1]]
                          const joinL = !!prev?.length && primary(prev).barKey === e.barKey
                          const joinR = !!next?.length && primary(next).barKey === e.barKey
                          const k = KIND[e.kind]
                          return (
                            <td key={d} className={`${border} p-0 ${weekend ? 'bg-gray-50' : 'bg-white'}`}
                              onMouseEnter={ev => setHover({ x: ev.clientX, y: ev.clientY, truck: r.truck, date: d, entries: list })}
                              onMouseMove={ev => setHover(h => (h ? { ...h, x: ev.clientX, y: ev.clientY } : h))}>
                              <div className={`relative h-5 my-1 flex items-center justify-center font-semibold tabular-nums ${k.cell} ${k.text} ${past ? 'opacity-60' : ''}
                                ${joinL ? '' : 'ml-0.5 rounded-l'} ${joinR ? '' : 'mr-0.5 rounded-r'}
                                ${e.kind === 'REQUEST' ? 'ring-1 ring-inset ring-yellow-500 [background-image:repeating-linear-gradient(135deg,transparent_0_3px,rgba(255,255,255,.5)_3px_6px)]' : ''}`}>
                                {cellText(e)}
                                {list.length > 1 && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-red-500 ring-1 ring-white" title="More than one thing on this day" />}
                              </div>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Hover card */}
      {hover && (
        <div className="fixed z-50 pointer-events-none bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-xs w-64"
          style={{ left: Math.min(hover.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 270), top: hover.y + 14 }}>
          <div className="font-semibold text-gray-900">#{hover.truck} · {fmt(hover.date, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
          {hover.entries.map((e, i) => (
            <div key={i} className="mt-1.5 flex gap-2">
              <span className={`mt-0.5 w-2.5 h-2.5 rounded-sm flex-shrink-0 ${KIND[e.kind].swatch}`} />
              <div className="min-w-0">
                <div className="font-medium text-gray-800">
                  {KIND[e.kind].label}{e.hours !== null ? ` · ${e.hours} hrs` : e.kind === 'RESERVATION' || e.kind === 'COMMITTED' || e.kind === 'REQUEST' ? ' · hours not on file' : ''}
                </div>
                {e.kind !== 'OPEN' && <div className="text-gray-500 truncate">{e.campaign}</div>}
                {e.kind !== 'OPEN' && <div className="text-gray-500 truncate">{[e.client, e.market].filter(Boolean).join(' · ')}</div>}
                {e.driver && <div className="text-gray-500">Driver: {e.driver}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

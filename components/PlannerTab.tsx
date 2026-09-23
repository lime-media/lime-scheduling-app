'use client'

/**
 * LED Quote -> Multi-market plan.
 *
 * Paste a client's ZIP list, review the areas it becomes, then plan weekly
 * coverage across the fleet: which trucks, from when, what repositioning costs,
 * and what the commitment leaves for everyone else. Internal only.
 */

import { useMemo, useState } from 'react'
import type { Area, AreaBuildResult, AreaFlag } from '@/lib/planning/areas'
import type { PlanResponse } from '@/lib/planning/run'
import type { CoverageModel } from '@/lib/planning/planner'

const fmtMoney = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
const fmtNum = (n: number) => Math.round(n).toLocaleString('en-US')
const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—'
const range = (lo: number, hi: number) => (lo === hi ? `${lo}` : `${lo} to ${hi}`)

function isoDate(d: Date): string { return d.toISOString().split('T')[0] }
function nextMondayAtLeast(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1)
  return isoDate(d)
}
function plusWeeks(date: string, weeks: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + weeks * 7)
  return isoDate(d)
}

const FLAG_LABELS: Record<AreaFlag['kind'], string> = {
  NOT_GEOCODED: 'No households (PO box or unique ZIP)',
  OUTLIER: 'Probable typo — far from the rest of its DMA',
  DUPLICATE: 'Listed twice',
  NO_LABEL: 'No DMA given',
  OUTSIDE_48: 'Outside the contiguous 48',
  INVALID_ZIP: 'Not a ZIP code',
}
const MODEL_LABELS: Record<CoverageModel, string> = { '3x12': '3 × 12 hours', '5x8': '5 × 8 hours' }

const card = 'bg-white border border-gray-200 rounded-xl shadow-sm p-4 mb-4'
const input = 'border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent w-full'
const th = 'text-left text-xs font-medium text-gray-500 px-2 py-1.5 border-b border-gray-200 whitespace-nowrap'
const td = 'px-2 py-1.5 border-b border-gray-100 text-sm text-gray-800 align-top'
const tdNum = td + ' text-right tabular-nums'

export function PlannerTab() {
  const [text, setText] = useState('')
  const [areasLoading, setAreasLoading] = useState(false)
  const [areasError, setAreasError] = useState<string | null>(null)
  const [built, setBuilt] = useState<AreaBuildResult | null>(null)

  const defaultStart = useMemo(() => nextMondayAtLeast(14), [])
  const [settings, setSettings] = useState({
    model: '3x12' as CoverageModel,
    planStart: defaultStart,
    planThrough: plusWeeks(defaultStart, 26),
    hopLimitRoadMiles: 250,
    reserveSoftHolds: true,
    alloyRenews: false,
    maintenanceReserve: 7,
    reservedLow: 20,
    reservedHigh: 25,
    smartDirectional: false,
  })
  const [planLoading, setPlanLoading] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [plan, setPlan] = useState<PlanResponse | null>(null)

  const onFile = async (f: File | undefined) => {
    if (!f) return
    setText(await f.text())
  }

  const buildAreasNow = async () => {
    setAreasLoading(true); setAreasError(null); setBuilt(null); setPlan(null)
    try {
      const res = await fetch('/api/plan/areas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not build areas')
      setBuilt(data)
    } catch (e) {
      setAreasError(e instanceof Error ? e.message : 'Could not build areas')
    } finally {
      setAreasLoading(false)
    }
  }

  const runPlanNow = async () => {
    if (!built) return
    setPlanLoading(true); setPlanError(null); setPlan(null)
    try {
      const res = await fetch('/api/plan/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ areas: built.areas, ...settings }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'The plan could not be run')
      setPlan(data)
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : 'The plan could not be run')
    } finally {
      setPlanLoading(false)
    }
  }

  const set = <K extends keyof typeof settings>(k: K, v: (typeof settings)[K]) => setSettings(p => ({ ...p, [k]: v }))

  return (
    <div>
      {/* 1. Client file */}
      <div className={card}>
        <h2 className="text-sm font-semibold text-gray-900 mb-1">1. Client ZIP list</h2>
        <p className="text-xs text-gray-500 mb-3">
          Paste or upload CSV with a header row naming the DMA and ZIP columns (City and State optional). Several sheets pasted together are fine.
        </p>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={6}
          placeholder={'DMA Name,Zip,City,State\nGreensboro,27260,High Point,NC\n...'}
          className={input + ' font-mono text-xs'}
        />
        <div className="flex items-center gap-3 mt-3">
          <label className="text-sm text-green-700 hover:text-green-800 cursor-pointer">
            <input type="file" accept=".csv,.tsv,.txt" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
            Upload CSV
          </label>
          <button
            onClick={buildAreasNow}
            disabled={areasLoading || !text.trim()}
            className="ml-auto bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium"
          >
            {areasLoading ? 'Building…' : 'Build areas'}
          </button>
        </div>
        {areasError && <div className="mt-3 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-800">{areasError}</div>}
      </div>

      {built && <AreasPanel built={built} />}

      {/* 2. Settings */}
      {built && (
        <div className={card}>
          <h2 className="text-sm font-semibold text-gray-900 mb-3">2. Plan settings</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Coverage</label>
              <select value={settings.model} onChange={e => set('model', e.target.value as CoverageModel)} className={input}>
                <option value="3x12">3 × 12 hours (pairs areas)</option>
                <option value="5x8">5 × 8 hours (one truck per area)</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Earliest start</label>
              <input type="date" value={settings.planStart} onChange={e => set('planStart', e.target.value)} className={input} />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Plan through</label>
              <input type="date" value={settings.planThrough} onChange={e => set('planThrough', e.target.value)} className={input} />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Pair areas within (road mi)</label>
              <input type="number" min={0} max={450} value={settings.hopLimitRoadMiles} onChange={e => set('hopLimitRoadMiles', Number(e.target.value))} className={input} disabled={settings.model === '5x8'} />
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">AT&amp;T trucks per week</label>
              <div className="flex items-center gap-1">
                <input type="number" min={0} value={settings.reservedLow} onChange={e => set('reservedLow', Number(e.target.value))} className={input} />
                <span className="text-gray-400 text-sm">to</span>
                <input type="number" min={0} value={settings.reservedHigh} onChange={e => set('reservedHigh', Number(e.target.value))} className={input} />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Maintenance reserve</label>
              <input type="number" min={0} value={settings.maintenanceReserve} onChange={e => set('maintenanceReserve', Number(e.target.value))} className={input} />
            </div>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 mt-3 text-sm text-gray-700">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={settings.reserveSoftHolds} onChange={e => set('reserveSoftHolds', e.target.checked)} />
              Keep AT&amp;T soft-hold trucks reserved
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={settings.alloyRenews} onChange={e => set('alloyRenews', e.target.checked)} />
              AT&amp;T Alloy Build renews (keep its trucks)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={settings.smartDirectional} onChange={e => set('smartDirectional', e.target.checked)} />
              Price smart directional
            </label>
          </div>
          <div className="flex mt-4">
            <button
              onClick={runPlanNow}
              disabled={planLoading || built.areas.length === 0}
              className="ml-auto bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium"
            >
              {planLoading ? 'Planning…' : 'Run plan'}
            </button>
          </div>
          {planError && <div className="mt-3 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-800">{planError}</div>}
        </div>
      )}

      {plan && built && <PlanResults plan={plan} areas={built.areas} />}
    </div>
  )
}

// ---------------------------------------------------------------------------

function AreasPanel({ built }: { built: AreaBuildResult }) {
  const [showAreas, setShowAreas] = useState(false)
  const byKind = new Map<AreaFlag['kind'], AreaFlag[]>()
  for (const f of built.flags) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f])
  const merged = built.areas.filter(a => a.labels.length > 1)

  return (
    <div className={card}>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-700 mb-3">
        <span><b>{fmtNum(built.rows)}</b> rows</span>
        <span><b>{fmtNum(built.uniqueZips)}</b> unique ZIPs</span>
        <span><b>{built.areas.length}</b> areas</span>
      </div>

      {built.flags.length > 0 && (
        <div className="mb-3">
          <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Raise with the client</h3>
          {[...byKind.entries()].map(([kind, list]) => (
            <details key={kind} className="text-sm border-b border-gray-100 py-1">
              <summary className="cursor-pointer text-gray-800">{FLAG_LABELS[kind]} <span className="text-gray-500">({list.length})</span></summary>
              <ul className="mt-1 ml-4 text-xs text-gray-600 list-disc">
                {list.map((f, i) => <li key={i}>{f.detail}</li>)}
              </ul>
            </details>
          ))}
        </div>
      )}
      {merged.length > 0 && (
        <p className="text-xs text-gray-600 mb-3">
          Worked as one area (DMAs within 30 miles): {merged.map(a => a.name).join('; ')}.
        </p>
      )}

      <button onClick={() => setShowAreas(s => !s)} className="text-sm text-green-700 hover:text-green-800">
        {showAreas ? 'Hide areas' : `Show all ${built.areas.length} areas`}
      </button>
      {showAreas && (
        <div className="overflow-x-auto mt-2">
          <table className="w-full">
            <thead><tr><th className={th}>Area</th><th className={th + ' text-right'}>ZIPs</th><th className={th + ' text-right'}>With households</th><th className={th + ' text-right'}>Spread (mi)</th><th className={th}>Nearest market</th></tr></thead>
            <tbody>
              {built.areas.map(a => (
                <tr key={a.id}>
                  <td className={td}>{a.name}</td>
                  <td className={tdNum}>{a.zips.length}</td>
                  <td className={tdNum}>{a.residentialZips}</td>
                  <td className={tdNum}>{a.spreadMiles}</td>
                  <td className={td}>{a.nearestMarket ? `${a.nearestMarket.name} (${a.nearestMarket.distanceMiles} mi)` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function PlanResults({ plan, areas }: { plan: PlanResponse; areas: Area[] }) {
  const { pricing, phased, milestones, capacity } = plan
  const chosen = pricing.chosen
  const lastLive = milestones[milestones.length - 1]
  const firstLive = milestones[0]
  const areaName = new Map(areas.map(a => [a.id, a.name]))

  const downloadCsv = () => {
    const rows = [['Route', 'Hop (road mi)', 'Truck', 'Starts', 'Drives to first', 'Coming from', 'Deadhead (mi)', 'Repositioning ($)']]
    for (const a of phased.assignments) {
      rows.push([a.routeName, String(a.hopRoadMiles || ''), a.truckNumber ?? 'UNSERVED', a.start ?? '', a.firstAreaId ? areaName.get(a.firstAreaId) ?? '' : '', a.originLabel ?? '', String(a.distanceMiles), String(Math.round(a.repositionCost))])
    }
    const csv = rows.map(r => r.map(c => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `plan-${plan.settings.model}-${plan.settings.planStart}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      {/* Headline */}
      <div className={card}>
        <h2 className="text-sm font-semibold text-gray-900 mb-3">3. Plan — {MODEL_LABELS[plan.settings.model]}</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Trucks" value={String(plan.routes.length)} sub={`${plan.routes.filter(r => r.areaIds.length === 2).length} paired, ${plan.routes.filter(r => r.areaIds.length === 1).length} single`} />
          <Stat label="Per week" value={fmtMoney(chosen.totalPerWeek)} sub={`${fmtMoney(chosen.totalPerQuarter)} per quarter`} />
          <Stat label="Coverage" value={`${fmtDate(firstLive?.date)} → ${fmtDate(lastLive?.date)}`} sub={`${firstLive?.routesLive ?? 0} routes first day, all ${lastLive?.routesLive ?? 0} by the last`} />
          <Stat label="Repositioning (absorbed)" value={fmtMoney(phased.repositionCost)} sub={`${phased.movesOverServiceArea} moves beyond the service area`} />
        </div>
        {plan.warnings.length > 0 && (
          <ul className="mt-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-sm text-amber-900 list-disc list-inside">
            {plan.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}
      </div>

      {/* Pricing */}
      <div className={card}>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Pricing (rate card)</h3>
        <table className="w-full">
          <thead><tr><th className={th}>Per week</th><th className={th + ' text-right'}>{MODEL_LABELS[pricing.chosen.model]}</th><th className={th + ' text-right'}>{MODEL_LABELS[pricing.other.model]}</th></tr></thead>
          <tbody>
            {([
              ['Rate per truck-day', 'effectiveDailyRate'],
              ['Truck-days', 'truckDaysPerWeek'],
              ['Truck-hours', 'truckHoursPerWeek'],
              ['Base media', 'baseMediaPerWeek'],
              ['Shadow fencing', 'shadowFencingPerWeek'],
              ['Smart directional', 'smartDirectionalPerWeek'],
              ['Total', 'totalPerWeek'],
              ['Total per 13-week quarter', 'totalPerQuarter'],
            ] as const).map(([label, key]) => {
              const money = !['truckDaysPerWeek', 'truckHoursPerWeek'].includes(key)
              const f = (n: number) => (money ? fmtMoney(n) : fmtNum(n))
              if (key === 'smartDirectionalPerWeek' && pricing.chosen.smartDirectionalPerWeek === 0) return null
              return (
                <tr key={key} className={key === 'totalPerWeek' ? 'font-semibold' : ''}>
                  <td className={td}>{label}</td>
                  <td className={tdNum}>{f(pricing.chosen[key])}</td>
                  <td className={tdNum}>{f(pricing.other[key])}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Start options */}
      <div className={card}>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Start options</h3>
        <p className="text-xs text-gray-500 mb-2">Every route starting together, versus each route starting as soon as its best-placed truck is free.</p>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr><th className={th}>Start</th><th className={th}>Date</th><th className={th + ' text-right'}>Trucks clear</th><th className={th + ' text-right'}>Spare</th><th className={th + ' text-right'}>Deadhead (mi)</th><th className={th + ' text-right'}>Repositioning</th></tr></thead>
            <tbody>
              {plan.startOptions.map((o, i) => (
                <tr key={i} className={o.label === 'Phased' ? 'font-semibold bg-green-50' : ''}>
                  <td className={td}>{o.label}</td>
                  <td className={td}>{o.label === 'Phased' ? `${fmtDate(firstLive?.date)} → ${fmtDate(lastLive?.date)}` : fmtDate(o.startDate)}</td>
                  <td className={tdNum}>{o.label === 'Phased' ? '—' : o.trucksClear}</td>
                  <td className={tdNum}>{o.label === 'Phased' ? '—' : o.outcome.feasible ? o.spare : `short by ${o.outcome.shortBy}`}</td>
                  <td className={tdNum}>{o.outcome.feasible ? fmtNum(o.outcome.deadheadMiles) : '—'}</td>
                  <td className={tdNum}>{o.outcome.feasible ? fmtMoney(o.outcome.repositionCost) : 'not possible'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {milestones.length > 1 && (
          <p className="text-xs text-gray-600 mt-2">
            Phased: {milestones.map(m => `${m.routesLive} by ${fmtDate(m.date)}`).join(', ')}.
          </p>
        )}
      </div>

      {/* Routes */}
      <div className={card}>
        <div className="flex items-center mb-2">
          <h3 className="text-sm font-semibold text-gray-900">Routes (phased start)</h3>
          <button onClick={downloadCsv} className="ml-auto text-sm text-green-700 hover:text-green-800">Download CSV</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr><th className={th}>Route</th><th className={th + ' text-right'}>Hop</th><th className={th}>Truck</th><th className={th}>Coming from</th><th className={th + ' text-right'}>Deadhead</th><th className={th}>Starts</th></tr></thead>
            <tbody>
              {phased.assignments.map(a => (
                <tr key={a.routeId}>
                  <td className={td}>{a.routeName}</td>
                  <td className={tdNum}>{a.hopRoadMiles ? `${a.hopRoadMiles} mi` : '—'}</td>
                  <td className={td}>{a.truckNumber ?? <span className="text-red-700">no truck</span>}</td>
                  <td className={td}>{a.originLabel ?? '—'}</td>
                  <td className={tdNum}>{a.truckNumber ? `${fmtNum(a.distanceMiles)} mi` : '—'}</td>
                  <td className={td}>{fmtDate(a.start)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {plan.settings.model === '3x12' && (
          <p className="text-xs text-gray-500 mt-2">
            Paired trucks alternate each week: area A Mon–Wed, travel and service Thursday, area B Fri–Sun, then the reverse. Each area gets three 12-hour days every calendar week. Each paired route needs two drivers.
          </p>
        )}
      </div>

      {/* Capacity */}
      <div className={card}>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">What it leaves for other clients</h3>
        <p className="text-xs text-gray-500 mb-2">Trucks per week, steady state. AT&amp;T&apos;s soft-hold trucks are part of its range, not added to it.</p>
        <table className="w-full">
          <thead><tr><th className={th}>Trucks</th>{capacity.rows.map(r => <th key={r.model} className={th + ' text-right'}>{MODEL_LABELS[r.model]}</th>)}</tr></thead>
          <tbody>
            <tr><td className={td}>Active fleet</td>{capacity.rows.map(r => <td key={r.model} className={tdNum}>{capacity.activeTrucks}</td>)}</tr>
            <tr><td className={td}>Maintenance</td>{capacity.rows.map(r => <td key={r.model} className={tdNum}>{capacity.maintenanceReserve}</td>)}</tr>
            <tr><td className={td}>AT&amp;T</td>{capacity.rows.map(r => <td key={r.model} className={tdNum}>{range(capacity.reservedLow, capacity.reservedHigh)}</td>)}</tr>
            {capacity.renewingTrucks > 0 && <tr><td className={td}>AT&amp;T Alloy Build (renewing)</td>{capacity.rows.map(r => <td key={r.model} className={tdNum}>{capacity.renewingTrucks}</td>)}</tr>}
            <tr><td className={td}>This client</td>{capacity.rows.map(r => <td key={r.model} className={tdNum}>{r.programTrucks}</td>)}</tr>
            <tr className="font-semibold"><td className={td}>Left for other clients</td>{capacity.rows.map(r => <td key={r.model} className={tdNum + (r.leftHigh < 0 ? ' text-red-700' : '')}>{r.leftHigh < 0 ? `short by ${range(-r.leftHigh, -r.leftLow)}` : range(Math.max(0, r.leftLow), r.leftHigh)}</td>)}</tr>
          </tbody>
        </table>
        <p className="text-xs text-gray-600 mt-2">
          Last 52 weeks: AT&amp;T core used a median of {capacity.history.reservedCore.median} trucks a week (middle half {capacity.history.reservedCore.p25} to {capacity.history.reservedCore.p75}); Alloy Build averaged {capacity.history.renewingRecent} over the last 8 weeks.
          Other clients averaged {capacity.history.other.winter} in winter, {capacity.history.other.spring} in spring and {capacity.history.other.summer} in summer, peaking at {capacity.history.other.max}.
        </p>
        <details className="mt-2 text-xs text-gray-600">
          <summary className="cursor-pointer">{plan.fleet.reserved.length} trucks held back · {plan.fleet.candidates} considered</summary>
          <p className="mt-1">{plan.fleet.reserved.map(r => `${r.truckNumber} (${r.reason})`).join(', ') || 'None'}</p>
        </details>
      </div>
    </>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-gray-100 rounded-lg p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-semibold text-gray-900 tabular-nums">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  )
}

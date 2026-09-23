'use client'

/**
 * LED Quote -> Multi-market plan.
 *
 * Paste a client's ZIP list, review the areas it becomes, then plan weekly
 * coverage across the fleet: which trucks, from when, what repositioning costs,
 * and what the commitment leaves for everyone else. Internal only.
 */

import { useMemo, useState } from 'react'
import type { Area, AreaBuildResult, AreaFlag, ZipRow } from '@/lib/planning/areas'
import type { PlanResponse } from '@/lib/planning/run'
import type { CoverageModel } from '@/lib/planning/planner'
import type { FootprintRequest, ReviewFinding, WriteUp } from '@/lib/planning/claude'

type BuiltAreas = AreaBuildResult & {
  source: 'csv' | 'xlsx' | 'claude' | 'rows'
  parsedRows: ZipRow[]
  request: FootprintRequest | null
  notes: string[]
}

// Vercel caps a request body at 4.5 MB; base64 adds a third.
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024

async function fileToBase64(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

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
  BEYOND_REACH: 'Over an hour from the area centre (assumed covered)',
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
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null)
  const [areasLoading, setAreasLoading] = useState(false)
  const [areasError, setAreasError] = useState<string | null>(null)
  const [built, setBuilt] = useState<BuiltAreas | null>(null)
  const [review, setReview] = useState<{ loading: boolean; error: string | null; findings: ReviewFinding[] | null }>({ loading: false, error: null, findings: null })

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
  const [selected, setSelected] = useState(0)

  const onFile = async (f: File | undefined) => {
    if (!f) return
    setAreasError(null)
    const lower = f.name.toLowerCase()
    if (lower.endsWith('.xlsx') || lower.endsWith('.pdf')) {
      if (f.size > MAX_UPLOAD_BYTES) { setAreasError('That file is over 3 MB. Save the ZIP list as CSV and paste it instead.'); return }
      setFile({ name: f.name, base64: await fileToBase64(f) })
      setText('')
    } else {
      setFile(null)
      setText(await f.text())
    }
  }

  const runReview = async (b: BuiltAreas) => {
    setReview({ loading: true, error: null, findings: null })
    try {
      const res = await fetch('/api/plan/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: b.parsedRows, areas: b.areas, flags: b.flags }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Review failed')
      setReview({ loading: false, error: null, findings: data.findings })
    } catch (e) {
      setReview({ loading: false, error: e instanceof Error ? e.message : 'Review failed', findings: null })
    }
  }

  const submitAreas = async (payload: object, keepReview = false) => {
    setAreasLoading(true); setAreasError(null); setPlan(null)
    if (!keepReview) setReview({ loading: false, error: null, findings: null })
    try {
      const res = await fetch('/api/plan/areas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not build areas')
      // A rebuild from corrected rows keeps what was learned from the original file.
      setBuilt(prev => (keepReview && prev ? { ...data, source: prev.source, request: prev.request, notes: prev.notes } : data))
      if (data.request?.startDate && /^\d{4}-\d{2}-\d{2}$/.test(data.request.startDate)) {
        setSettings(p => ({ ...p, planStart: data.request.startDate, planThrough: plusWeeks(data.request.startDate, 26) }))
      }
      if (!keepReview) runReview(data)
    } catch (e) {
      setAreasError(e instanceof Error ? e.message : 'Could not build areas')
    } finally {
      setAreasLoading(false)
    }
  }

  const buildAreasNow = () => submitAreas(file ? { file } : { text })

  /** Apply a verified correction to the rows and rebuild the areas. */
  const applyFinding = (f: ReviewFinding) => {
    if (!built) return
    const rows = built.parsedRows.map(r => {
      if (f.kind === 'LIKELY_TYPO' && f.suggestedZip && r.zip === f.zip) return { ...r, zip: f.suggestedZip }
      if (f.kind === 'LABEL_MISMATCH' && f.suggestedDma && r.label === f.dma) return { ...r, label: f.suggestedDma }
      return r
    })
    setReview(p => ({ ...p, findings: p.findings?.filter(x => x !== f) ?? null }))
    submitAreas({ rows }, true)
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
      setSelected(data.defaultOption ?? 0)
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
          Upload the client&apos;s file (.xlsx, .csv or .pdf) or paste the list, or an email containing it. A header row naming the DMA and ZIP columns is read directly; anything else is read by Claude.
        </p>
        {file && (
          <div className="flex items-center gap-2 mb-2 text-sm text-gray-700">
            <span className="bg-gray-100 rounded px-2 py-1">{file.name}</span>
            <button onClick={() => setFile(null)} className="text-xs text-gray-500 hover:text-gray-700">Remove</button>
          </div>
        )}
        <textarea
          value={text}
          disabled={!!file}
          onChange={e => setText(e.target.value)}
          rows={6}
          placeholder={'DMA Name,Zip,City,State\nGreensboro,27260,High Point,NC\n...'}
          className={input + ' font-mono text-xs'}
        />
        <div className="flex items-center gap-3 mt-3">
          <label className="text-sm text-green-700 hover:text-green-800 cursor-pointer">
            <input type="file" accept=".xlsx,.csv,.tsv,.txt,.pdf,.eml" className="hidden" onChange={e => { onFile(e.target.files?.[0]); e.target.value = '' }} />
            Upload file
          </label>
          <button
            onClick={buildAreasNow}
            disabled={areasLoading || (!file && !text.trim())}
            className="ml-auto bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium"
          >
            {areasLoading ? (file?.name.toLowerCase().endsWith('.pdf') ? 'Claude is reading the file…' : 'Building…') : 'Build areas'}
          </button>
        </div>
        {areasError && <div className="mt-3 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-800">{areasError}</div>}
      </div>

      {built && <AreasPanel built={built} review={review} onApply={applyFinding} onRecheck={() => runReview(built)} />}

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

      {plan && built && <PlanResults plan={plan} areas={built.areas} selected={selected} onSelect={setSelected} />}
      {plan && built && <WriteUpPanel plan={plan} built={built} selected={selected} />}
    </div>
  )
}

// ---------------------------------------------------------------------------

const REVIEW_LABELS: Record<ReviewFinding['kind'], string> = {
  LABEL_MISMATCH: 'Label names a different place',
  LIKELY_TYPO: 'Likely typo',
  OTHER: 'Check with the client',
}

function AreasPanel({ built, review, onApply, onRecheck }: {
  built: BuiltAreas
  review: { loading: boolean; error: string | null; findings: ReviewFinding[] | null }
  onApply: (f: ReviewFinding) => void
  onRecheck: () => void
}) {
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

      {built.source === 'claude' && (
        <div className="mb-3 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm text-blue-900">
          Claude read this file. Spot-check the row count against the original.
          {built.request?.summary && <div className="mt-1 text-xs"><b>Client asked for:</b> {built.request.summary}</div>}
          {built.notes.length > 0 && <ul className="mt-1 text-xs list-disc list-inside">{built.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
        </div>
      )}

      <div className="mb-3">
        <div className="flex items-center">
          <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Claude review</h3>
          {!review.loading && <button onClick={onRecheck} className="ml-auto text-xs text-green-700 hover:text-green-800">Check again</button>}
        </div>
        {review.loading && <p className="text-sm text-gray-500 mt-1">Claude is checking the labels and ZIPs…</p>}
        {review.error && <p className="text-sm text-amber-800 mt-1">{review.error}</p>}
        {review.findings && review.findings.length === 0 && <p className="text-sm text-gray-600 mt-1">Nothing beyond the flags below.</p>}
        {review.findings && review.findings.length > 0 && (
          <ul className="mt-1 space-y-2">
            {review.findings.map((f, i) => {
              const canApply = (f.kind === 'LIKELY_TYPO' && f.suggestedZip && f.verified) || (f.kind === 'LABEL_MISMATCH' && f.suggestedDma)
              return (
                <li key={i} className="text-sm border border-gray-100 rounded-lg px-3 py-2">
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <span className="font-medium text-gray-900">{REVIEW_LABELS[f.kind]}</span>
                      <span className="text-gray-500"> · {f.dma}{f.zip ? ` · ${f.zip}` : ''}</span>
                      <div className="text-gray-700">{f.detail}</div>
                      {f.suggestedZip && (
                        <div className={`text-xs mt-0.5 ${f.verified ? 'text-green-700' : 'text-amber-700'}`}>
                          Suggested {f.suggestedZip}: {f.verification}
                        </div>
                      )}
                      {f.suggestedDma && <div className="text-xs mt-0.5 text-gray-600">Suggested label: {f.suggestedDma}</div>}
                    </div>
                    {canApply && (
                      <button onClick={() => onApply(f)} className="shrink-0 text-xs bg-green-600 hover:bg-green-700 text-white rounded px-2 py-1">Apply</button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
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
            <thead><tr><th className={th}>Area</th><th className={th + ' text-right'}>ZIPs</th><th className={th + ' text-right'}>With households</th><th className={th + ' text-right'}>Spread (mi)</th></tr></thead>
            <tbody>
              {built.areas.map(a => (
                <tr key={a.id}>
                  <td className={td}>{a.name}</td>
                  <td className={tdNum}>{a.zips.length}</td>
                  <td className={tdNum}>{a.residentialZips}</td>
                  <td className={tdNum}>{a.spreadMiles}</td>
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

function PlanResults({ plan, areas, selected, onSelect }: {
  plan: PlanResponse
  areas: Area[]
  selected: number
  onSelect: (i: number) => void
}) {
  const { pricing, capacity } = plan
  const chosen = pricing.chosen
  const option = plan.dateOptions[selected] ?? plan.dateOptions[0]
  const outcome = option?.liveBy
  const milestones = outcome?.milestones ?? []
  const firstLive = milestones[0]
  const areaName = new Map(areas.map(a => [a.id, a.name]))

  const downloadCsv = () => {
    if (!outcome) return
    const rows = [['Route', 'Hop (road mi)', 'Truck', 'VIN', 'Starts', 'Drives to first', 'Coming from', 'Deadhead (mi)', 'Transport absorbed ($)']]
    for (const a of outcome.assignments) {
      rows.push([a.routeName, String(a.hopRoadMiles || ''), a.truckNumber ?? `NOT LIVE BY ${option.date}`, a.vin ?? '', a.start ?? '', a.firstAreaId ? areaName.get(a.firstAreaId) ?? '' : '', a.originLabel ?? '', String(a.distanceMiles), String(Math.round(a.repositionCost))])
    }
    const csv = rows.map(r => r.map(c => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `plan-${plan.settings.model}-live-by-${option.date}.csv`
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
          <Stat
            label="Everything live by"
            value={option ? fmtDate(option.date) : '—'}
            sub={outcome?.feasible ? `${firstLive?.routesLive ?? 0} routes live ${fmtDate(firstLive?.date)}` : `short by ${outcome?.shortBy ?? 0} routes`}
          />
          <Stat label="Transport we absorb" value={outcome ? fmtMoney(outcome.repositionCost) : '—'} sub={`${outcome?.movesOverServiceArea ?? 0} moves beyond the service area`} />
        </div>
        {plan.warnings.length > 0 && (
          <ul className="mt-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-sm text-amber-900 list-disc list-inside">
            {plan.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}
      </div>

      {/* The decision */}
      <div className={card}>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Start date vs. transport we absorb</h3>
        <p className="text-xs text-gray-500 mb-2">
          Earlier dates mean bringing trucks from further away. For each date, trucks are chosen to keep the transport we absorb as low as possible, and each route starts as soon as its truck is ready. Pick the row that is worth it; the routes below follow your choice.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}></th>
                <th className={th}>Everything live by</th>
                <th className={th + ' text-right'}>Transport we absorb</th>
                <th className={th + ' text-right'}>Routes live {fmtDate(plan.settings.planStart)}</th>
                <th className={th + ' text-right'}>Trucks free</th>
              </tr>
            </thead>
            <tbody>
              {plan.dateOptions.map((o, i) => (
                <tr key={o.date} onClick={() => onSelect(i)} className={`cursor-pointer ${i === selected ? 'bg-green-50 font-semibold' : 'hover:bg-gray-50'}`}>
                  <td className={td}><input type="radio" readOnly checked={i === selected} /></td>
                  <td className={td}>{fmtDate(o.date)}</td>
                  <td className={tdNum}>{o.liveBy.feasible ? fmtMoney(o.liveBy.repositionCost) : <span className="text-gray-500">not possible — short by {o.liveBy.shortBy} route{o.liveBy.shortBy === 1 ? '' : 's'}</span>}</td>
                  <td className={tdNum}>{o.liveBy.milestones[0]?.date === plan.settings.planStart ? o.liveBy.milestones[0].routesLive : 0} of {plan.routes.length}</td>
                  <td className={tdNum}>{o.trucksClear}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {milestones.length > 1 && (
          <p className="text-xs text-gray-600 mt-2">
            Live by {fmtDate(option.date)}: {milestones.map(m => `${m.routesLive} by ${fmtDate(m.date)}`).join(', ')}.
          </p>
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

      {/* Routes */}
      <div className={card}>
        <div className="flex items-center mb-2">
          <h3 className="text-sm font-semibold text-gray-900">Routes — everything live by {option ? fmtDate(option.date) : '—'}</h3>
          <button onClick={downloadCsv} className="ml-auto text-sm text-green-700 hover:text-green-800">Download CSV</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr><th className={th}>Route</th><th className={th + ' text-right'}>Hop</th><th className={th}>Truck</th><th className={th}>VIN</th><th className={th}>Coming from</th><th className={th + ' text-right'}>Deadhead</th><th className={th + ' text-right'}>Absorbed</th><th className={th}>Starts</th></tr></thead>
            <tbody>
              {(outcome?.assignments ?? []).map(a => (
                <tr key={a.routeId}>
                  <td className={td}>{a.routeName}</td>
                  <td className={tdNum}>{a.hopRoadMiles ? `${a.hopRoadMiles} mi` : '—'}</td>
                  <td className={td}>{a.truckNumber ?? <span className="text-red-700">not live by {fmtDate(option.date)}</span>}</td>
                  <td className={td + ' font-mono text-xs'}>{a.vin ?? '—'}</td>
                  <td className={td}>{a.originLabel ?? '—'}</td>
                  <td className={tdNum}>{a.truckNumber ? `${fmtNum(a.distanceMiles)} mi` : '—'}</td>
                  <td className={tdNum}>{a.truckNumber ? (a.repositionCost ? fmtMoney(a.repositionCost) : '—') : '—'}</td>
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

function WriteUpPanel({ plan, built, selected }: { plan: PlanResponse; built: BuiltAreas; selected: number }) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; result: WriteUp | null }>({ loading: false, error: null, result: null })
  const [copied, setCopied] = useState(false)

  const draft = async () => {
    setState({ loading: true, error: null, result: null })
    try {
      const counts = new Map<string, number>()
      for (const f of built.flags) counts.set(FLAG_LABELS[f.kind], (counts.get(FLAG_LABELS[f.kind]) ?? 0) + 1)
      const res = await fetch('/api/plan/writeup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan,
          areaCount: built.areas.length,
          zipCount: built.uniqueZips,
          flagsSummary: [...counts].map(([k, n]) => `${k}: ${n}`),
          clientRequest: built.request?.summary,
          selectedOption: selected,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Write-up failed')
      setState({ loading: false, error: null, result: data })
    } catch (e) {
      setState({ loading: false, error: e instanceof Error ? e.message : 'Write-up failed', result: null })
    }
  }

  const copy = async () => {
    if (!state.result) return
    await navigator.clipboard.writeText(state.result.markdown)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={card}>
      <div className="flex items-center">
        <h3 className="text-sm font-semibold text-gray-900">Write-up</h3>
        <div className="ml-auto flex gap-3">
          {state.result && <button onClick={copy} className="text-sm text-green-700 hover:text-green-800">{copied ? 'Copied' : 'Copy'}</button>}
          <button onClick={draft} disabled={state.loading} className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium">
            {state.loading ? 'Claude is writing…' : state.result ? 'Redraft' : 'Draft with Claude'}
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-500 mt-1">A client section to adapt and an internal section, written from this plan&apos;s numbers only.</p>
      {state.error && <div className="mt-3 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-800">{state.error}</div>}
      {state.result && state.result.unverifiedNumbers.length > 0 && (
        <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-900">
          These figures are not in the plan. Check or remove them before sending: {state.result.unverifiedNumbers.join(', ')}
        </div>
      )}
      {state.result && (
        <div className="mt-3 whitespace-pre-wrap text-sm text-gray-800 border border-gray-100 rounded-lg p-3 bg-gray-50">{state.result.markdown}</div>
      )}
    </div>
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

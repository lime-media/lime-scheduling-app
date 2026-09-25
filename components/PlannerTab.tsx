'use client'

/**
 * LED Quote -> Multi-market Quote.
 *
 * Works like the single-market quote, for many markets at once: choose the
 * client, list the markets (typed, or from the client's ZIP file), get one
 * quote. Behind it the routing engine decides which trucks serve which
 * markets — sharing a truck between nearby markets week to week, chaining
 * markets that follow each other — for the least transport and driving, and
 * leaves the most trucks free for other clients. Then place every hold and
 * one Salesforce opportunity in one step.
 */

import { useState } from 'react'
import { AccountSearch, type SfdcAccount } from '@/components/AccountSearch'
import type { Area, AreaBuildResult, AreaFlag, ZipRow } from '@/lib/planning/areas'
import type { ReviewFinding } from '@/lib/planning/claude'
import type { MultiMarketQuote, QuoteRow, RowError } from '@/lib/planning/quote'

type BuiltAreas = AreaBuildResult & { source: string; parsedRows: ZipRow[]; notes: string[] }

// Vercel caps a request body at 4.5 MB; base64 adds a third.
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024

// Each caller treats the body as its route's own response type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(res: Response): Promise<any> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(res.ok ? 'The server sent an unreadable response.' : `The server returned ${res.status}${res.status === 504 ? ' (timed out)' : ''}. Try again.`)
  }
}

async function fileToBase64(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

const fmtMoney = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
const fmtNum = (n: number) => Math.round(n).toLocaleString('en-US')
const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const todayStr = () => new Date().toISOString().split('T')[0]

const calendarDays = (start: string, end: string) =>
  start && end ? Math.round((new Date(end + 'T00:00:00Z').getTime() - new Date(start + 'T00:00:00Z').getTime()) / 86400000) + 1 : 0

// Same choices as the single-market quote, plus three days a week, which lets
// one truck alternate between two nearby markets.
const SCHEDULE_OPTIONS: { value: number; label: string }[] = [
  { value: 5, label: 'Mon-Fri' },
  { value: 6, label: 'Mon-Sat' },
  { value: 7, label: '7 days' },
  { value: 3, label: '3 days/wk (can alternate)' },
]
const scheduleLabel = (dpw: number) => (dpw === 3 ? '3 days/wk' : dpw === 5 ? 'Mon-Fri' : dpw === 6 ? 'Mon-Sat' : '7 days')

/** Like the single-market quote: 6 days or fewer runs every day; longer ranges pick a schedule. */
function ScheduleSelect({ start, end, value, onChange }: { start: string; end: string; value: number; onChange: (v: number) => void }) {
  const cal = calendarDays(start, end)
  if (cal > 0 && cal <= 6) return <div className="text-xs text-gray-500 px-1 py-2 whitespace-nowrap">Every day ({cal})</div>
  return (
    <select className={input} value={value} onChange={e => onChange(Number(e.target.value))}>
      {SCHEDULE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

let rowSeq = 0
const newRow = (defaults: Partial<QuoteRow> = {}): QuoteRow => ({
  id: `r${++rowSeq}`, market: '', startDate: '', endDate: '', trucks: 1, daysPerWeek: 5, hours: 8, ...defaults,
})

const FLAG_LABELS: Record<AreaFlag['kind'], string> = {
  NOT_GEOCODED: 'No households (PO box or unique ZIP)',
  OUTLIER: 'Probable typo, far from the rest of its DMA',
  BEYOND_REACH: 'Over an hour from the area centre (assumed covered)',
  UNCERTAIN_LOCATION: 'Location uncertain, its ZIPs disagree',
  NOT_PLACED: 'Not included, no ZIP we can locate',
  DUPLICATE: 'Listed twice',
  NO_LABEL: 'No DMA given',
  OUTSIDE_48: 'Outside the contiguous 48',
  INVALID_ZIP: 'Not a ZIP code',
}

const card = 'bg-white border border-gray-200 rounded-xl shadow-sm p-4 mb-4'
const input = 'border border-gray-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent w-full'
const th = 'text-left text-xs font-medium text-gray-500 px-2 py-1.5 border-b border-gray-200 whitespace-nowrap'
const td = 'px-2 py-1.5 border-b border-gray-100 text-sm text-gray-800 align-top'
const tdNum = td + ' text-right tabular-nums'

export function PlannerTab() {
  const [account, setAccount] = useState<SfdcAccount | null>(null)
  const [rows, setRows] = useState<QuoteRow[]>([newRow()])
  const [rowErrors, setRowErrors] = useState<RowError[]>([])
  const [features, setFeatures] = useState({ shadowFencing: true, smartDirectional: false, deviceId: false })
  const [alloyRenews, setAlloyRenews] = useState(false)

  // Intake
  const [showImport, setShowImport] = useState(false)
  const [text, setText] = useState('')
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null)
  const [bulk, setBulk] = useState({ startDate: '', endDate: '', trucks: 1, daysPerWeek: 5, hours: 8 })
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [built, setBuilt] = useState<BuiltAreas | null>(null)
  const [review, setReview] = useState<{ loading: boolean; error: string | null; findings: ReviewFinding[] | null }>({ loading: false, error: null, findings: null })

  // Quote
  const [quoting, setQuoting] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [quote, setQuote] = useState<MultiMarketQuote | null>(null)
  const [holding, setHolding] = useState(false)
  const [holdResult, setHoldResult] = useState<{ ok: boolean; message: string } | null>(null)
  // Markets to book. Every market with a truck is selected when a quote arrives.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const showQuote = (q: MultiMarketQuote) => {
    setQuote(q)
    setSelected(new Set(q.lines.filter(l => l.missing < l.trucks).map(l => l.id)))
  }

  const updateRow = (id: string, patch: Partial<QuoteRow>) => {
    setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)))
    setQuote(null); setHoldResult(null)
  }

  // ---- intake ------------------------------------------------------------

  const onFile = async (f: File | undefined) => {
    if (!f) return
    setImportError(null)
    const lower = f.name.toLowerCase()
    if (lower.endsWith('.xlsx') || lower.endsWith('.pdf')) {
      if (f.size > MAX_UPLOAD_BYTES) { setImportError('That file is over 3 MB. Save the ZIP list as CSV and paste it instead.'); return }
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
      const data = await readJson(res)
      if (!res.ok) throw new Error(data.error || 'Review failed')
      setReview({ loading: false, error: null, findings: data.findings })
    } catch (e) {
      setReview({ loading: false, error: e instanceof Error ? e.message : 'Review failed', findings: null })
    }
  }

  const areasToRows = (areas: Area[]) =>
    areas.map(a => newRow({ market: a.name, lat: a.lat, lng: a.lng, ...bulk }))

  const importAreas = async (payload: object, keepReview = false) => {
    setImporting(true); setImportError(null)
    try {
      const res = await fetch('/api/plan/areas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data = await readJson(res)
      if (!res.ok) throw new Error(data.error || 'Could not read that list')
      setBuilt(data)
      // Replace imported and blank rows; keep any the rep typed by hand.
      setRows(rs => [...rs.filter(r => r.market.trim() && r.lat === undefined), ...areasToRows(data.areas)])
      setQuote(null)
      if (!keepReview) runReview(data)
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Could not read that list')
    } finally {
      setImporting(false)
    }
  }

  const applyFinding = (f: ReviewFinding) => {
    if (!built) return
    const corrected = built.parsedRows.map(r => {
      if (f.kind === 'LIKELY_TYPO' && f.suggestedZip && r.zip === f.zip) return { ...r, zip: f.suggestedZip }
      if (f.kind === 'LABEL_MISMATCH' && f.suggestedDma && r.label === f.dma) return { ...r, label: f.suggestedDma }
      return r
    })
    setReview(p => ({ ...p, findings: p.findings?.filter(x => x !== f) ?? null }))
    importAreas({ rows: corrected }, true)
  }

  // ---- quote & holds -----------------------------------------------------

  const requestBody = () => ({
    rows,
    sfdcAccountId: account?.id,
    sfdcAccountName: account?.name,
    features,
    alloyRenews,
  })

  const getQuote = async () => {
    setQuoting(true); setQuoteError(null); setQuote(null); setRowErrors([]); setHoldResult(null)
    try {
      const res = await fetch('/api/plan/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody()) })
      const data = await readJson(res)
      if (!res.ok) {
        if (data.rowErrors) setRowErrors(data.rowErrors)
        throw new Error(data.error || 'The quote could not be built')
      }
      showQuote(data)
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : 'The quote could not be built')
    } finally {
      setQuoting(false)
    }
  }

  const placeHolds = async (allowPartial = false) => {
    if (!account) return
    setHolding(true); setHoldResult(null)
    try {
      const res = await fetch('/api/plan/hold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...requestBody(), selectedIds: [...selected], allowPartial }) })
      const data = await readJson(res)
      if (res.status === 409 && data.shortfalls) {
        const ok = window.confirm(`${data.error}\n\n${data.shortfalls.map((s: { market: string; missing: number }) => `${s.market}: ${s.missing} truck(s) short`).join('\n')}\n\nBook what can be covered? The rest will be noted on the Salesforce opportunity as quoted but not available, and left out of its amount.`)
        if (ok) { setHolding(false); return placeHolds(true) }
        setHoldResult({ ok: false, message: 'No holds placed.' })
        return
      }
      if (!res.ok) throw new Error(data.error || 'Holds could not be placed')
      setHoldResult({ ok: true, message: data.message + (data.skipped?.length ? ` ${data.skipped.length} skipped (booked since the quote was built).` : '') })
    } catch (e) {
      setHoldResult({ ok: false, message: e instanceof Error ? e.message : 'Holds could not be placed' })
    } finally {
      setHolding(false)
    }
  }

  const errorFor = (id: string) => rowErrors.find(e => e.rowId === id)
  const ready = rows.length > 0 && rows.every(r => r.market.trim() && r.startDate && r.endDate && r.trucks >= 1)

  return (
    <div>
      {/* 1. Client */}
      <div className={card}>
        <h2 className="text-sm font-semibold text-gray-900 mb-2">1. Select Client (Salesforce Account)</h2>
        <AccountSearch selected={account} onSelect={a => { setAccount(a); setQuote(null); setHoldResult(null) }} />
      </div>

      {/* 2. Markets */}
      <div className={card}>
        <div className="flex items-center mb-3">
          <h2 className="text-sm font-semibold text-gray-900">2. Markets</h2>
          <button onClick={() => setShowImport(s => !s)} className="ml-auto text-sm text-green-700 hover:text-green-800">
            {showImport ? 'Hide import' : 'Import from client file'}
          </button>
        </div>

        {showImport && (
          <ImportPanel
            text={text} setText={setText} file={file} setFile={setFile} onFile={onFile}
            bulk={bulk} setBulk={setBulk}
            importing={importing} error={importError}
            onImport={() => importAreas(file ? { file } : { text })}
            built={built} review={review} onApply={applyFinding} onRecheck={() => built && runReview(built)}
          />
        )}

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>Market</th><th className={th}>Start</th><th className={th}>End</th>
                <th className={th}>Trucks</th><th className={th}>Schedule</th><th className={th}>Hours</th><th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const err = errorFor(r.id)
                return (
                  <tr key={r.id}>
                    <td className={td + ' min-w-[12rem]'}>
                      <input className={input} placeholder="e.g. Dallas, TX" value={r.market}
                        onChange={e => updateRow(r.id, { market: e.target.value, lat: undefined, lng: undefined })} />
                      {r.lat !== undefined && <div className="text-[11px] text-gray-400 mt-0.5">From client file</div>}
                      {err && (
                        <div className="text-xs text-red-700 mt-1">
                          {err.message}
                          {err.candidates && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {err.candidates.slice(0, 8).map(c => (
                                <button key={c} onClick={() => { updateRow(r.id, { market: c }); setRowErrors(es => es.filter(x => x.rowId !== r.id)) }}
                                  className="bg-gray-100 hover:bg-gray-200 rounded px-1.5 py-0.5 text-gray-700">{c}</button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className={td}><input type="date" className={input} min={todayStr()} value={r.startDate} onChange={e => updateRow(r.id, { startDate: e.target.value })} /></td>
                    <td className={td}><input type="date" className={input} min={r.startDate || todayStr()} value={r.endDate} onChange={e => updateRow(r.id, { endDate: e.target.value })} /></td>
                    <td className={td + ' w-20'}><input type="number" min={1} max={50} className={input} value={r.trucks} onChange={e => updateRow(r.id, { trucks: Math.max(1, parseInt(e.target.value) || 1) })} /></td>
                    <td className={td + ' w-44'}>
                      <ScheduleSelect start={r.startDate} end={r.endDate} value={r.daysPerWeek} onChange={v => updateRow(r.id, { daysPerWeek: v })} />
                    </td>
                    <td className={td + ' w-20'}>
                      <select className={input} value={r.hours} onChange={e => updateRow(r.id, { hours: Number(e.target.value) })}>
                        {[8, 10, 12].map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </td>
                    <td className={td}>
                      <button onClick={() => setRows(rs => (rs.length > 1 ? rs.filter(x => x.id !== r.id) : rs))} className="text-gray-400 hover:text-red-600 text-sm" title="Remove">✕</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-3">
          <button onClick={() => setRows(rs => [...rs, newRow(rs.length ? { startDate: rs[rs.length - 1].startDate, endDate: rs[rs.length - 1].endDate, daysPerWeek: rs[rs.length - 1].daysPerWeek, hours: rs[rs.length - 1].hours } : {})])}
            className="text-sm text-green-700 hover:text-green-800">+ Add market</button>
          <span className="text-xs text-gray-500">{rows.length} market{rows.length === 1 ? '' : 's'}</span>
        </div>
      </div>

      {/* 3. Options */}
      <div className={card}>
        <h2 className="text-sm font-semibold text-gray-900 mb-2">3. Options</h2>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-700">
          <label className="flex items-center gap-2"><input type="checkbox" checked={features.shadowFencing} onChange={e => setFeatures(f => ({ ...f, shadowFencing: e.target.checked }))} /> Shadow fencing</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={features.smartDirectional} onChange={e => setFeatures(f => ({ ...f, smartDirectional: e.target.checked }))} /> Smart directional</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={features.deviceId} onChange={e => setFeatures(f => ({ ...f, deviceId: e.target.checked }))} /> Device ID passback</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={alloyRenews} onChange={e => setAlloyRenews(e.target.checked)} /> Keep AT&amp;T Alloy Build trucks reserved</label>
        </div>
        <div className="flex mt-4">
          <button onClick={getQuote} disabled={quoting || !ready}
            className="ml-auto bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg px-5 py-2.5 text-sm font-medium">
            {quoting ? 'Routing trucks…' : 'Get quote'}
          </button>
        </div>
        {quoteError && <div className="mt-3 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-800">{quoteError}</div>}
      </div>

      {quote && (
        <QuoteResult
          quote={quote}
          account={account}
          holding={holding}
          holdResult={holdResult}
          selected={selected}
          onToggle={id => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })}
          onPlaceHolds={() => placeHolds(false)}
          unplaced={built?.unplaced.map(u => u.label) ?? []}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

type Bulk = { startDate: string; endDate: string; trucks: number; daysPerWeek: number; hours: number }

function ImportPanel(p: {
  text: string; setText: (s: string) => void
  file: { name: string; base64: string } | null; setFile: (f: null) => void; onFile: (f: File | undefined) => void
  bulk: Bulk; setBulk: (b: Bulk) => void
  importing: boolean; error: string | null; onImport: () => void
  built: BuiltAreas | null
  review: { loading: boolean; error: string | null; findings: ReviewFinding[] | null }
  onApply: (f: ReviewFinding) => void; onRecheck: () => void
}) {
  const { bulk, setBulk, built, review } = p
  const byKind = new Map<AreaFlag['kind'], AreaFlag[]>()
  for (const f of built?.flags ?? []) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f])

  return (
    <div className="border border-gray-100 rounded-lg p-3 mb-4 bg-gray-50">
      <p className="text-xs text-gray-600 mb-2">
        Upload the client&apos;s file (.xlsx, .csv or .pdf) or paste the list, or an email containing it. Each DMA becomes a market row with the schedule below; edit any row afterwards.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-2">
        <div><label className="text-xs text-gray-600">Start</label><input type="date" className={input} value={bulk.startDate} onChange={e => setBulk({ ...bulk, startDate: e.target.value })} /></div>
        <div><label className="text-xs text-gray-600">End</label><input type="date" className={input} value={bulk.endDate} onChange={e => setBulk({ ...bulk, endDate: e.target.value })} /></div>
        <div><label className="text-xs text-gray-600">Trucks each</label><input type="number" min={1} className={input} value={bulk.trucks} onChange={e => setBulk({ ...bulk, trucks: Math.max(1, parseInt(e.target.value) || 1) })} /></div>
        <div><label className="text-xs text-gray-600">Schedule</label>
          <ScheduleSelect start={bulk.startDate} end={bulk.endDate} value={bulk.daysPerWeek} onChange={v => setBulk({ ...bulk, daysPerWeek: v })} /></div>
        <div><label className="text-xs text-gray-600">Hours</label>
          <select className={input} value={bulk.hours} onChange={e => setBulk({ ...bulk, hours: Number(e.target.value) })}>{[8, 10, 12].map(h => <option key={h} value={h}>{h}</option>)}</select></div>
      </div>
      {p.file && (
        <div className="flex items-center gap-2 mb-2 text-sm text-gray-700">
          <span className="bg-white border border-gray-200 rounded px-2 py-1">{p.file.name}</span>
          <button onClick={() => p.setFile(null)} className="text-xs text-gray-500 hover:text-gray-700">Remove</button>
        </div>
      )}
      <textarea value={p.text} disabled={!!p.file} onChange={e => p.setText(e.target.value)} rows={4}
        placeholder={'DMA Name,Zip,City,State\nGreensboro,27260,High Point,NC'} className={input + ' font-mono text-xs'} />
      <div className="flex items-center gap-3 mt-2">
        <label className="text-sm text-green-700 hover:text-green-800 cursor-pointer">
          <input type="file" accept=".xlsx,.csv,.tsv,.txt,.pdf,.eml" className="hidden" onChange={e => { p.onFile(e.target.files?.[0]); e.target.value = '' }} />
          Upload file
        </label>
        <button onClick={p.onImport} disabled={p.importing || (!p.file && !p.text.trim())}
          className="ml-auto bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium">
          {p.importing ? 'Reading…' : 'Import markets'}
        </button>
      </div>
      {p.error && <div className="mt-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-800">{p.error}</div>}

      {built && (
        <div className="mt-3 text-sm">
          <div className="text-gray-700">{fmtNum(built.uniqueZips)} ZIPs became {built.areas.length} markets.</div>
          {built.unplaced.length > 0 && (
            <div className="mt-2 bg-red-50 border border-red-300 rounded-lg px-3 py-2 text-red-900">
              <b>Not included:</b> {built.unplaced.map(u => u.label).join(', ')}. None of their ZIPs can be located. Get a residential ZIP from the client.
            </div>
          )}
          {review.loading && <div className="mt-2 text-gray-500">Claude is checking the labels and ZIPs…</div>}
          {review.error && <div className="mt-2 text-amber-800">{review.error}</div>}
          {review.findings && review.findings.length > 0 && (
            <ul className="mt-2 space-y-1">
              {review.findings.map((f, i) => {
                const canApply = (f.kind === 'LIKELY_TYPO' && f.suggestedZip && f.verified) || (f.kind === 'LABEL_MISMATCH' && f.suggestedDma)
                return (
                  <li key={i} className="flex items-start gap-2 bg-white border border-gray-100 rounded px-2 py-1.5">
                    <div className="flex-1 text-gray-700">
                      <span className="font-medium">{f.dma}{f.zip ? ` · ${f.zip}` : ''}:</span> {f.detail}
                      {f.suggestedZip && <span className={`block text-xs ${f.verified ? 'text-green-700' : 'text-amber-700'}`}>Suggested {f.suggestedZip}: {f.verification}</span>}
                    </div>
                    {canApply && <button onClick={() => p.onApply(f)} className="shrink-0 text-xs bg-green-600 hover:bg-green-700 text-white rounded px-2 py-1">Apply</button>}
                  </li>
                )
              })}
            </ul>
          )}
          {byKind.size > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-gray-600">{built.flags.length} list notes to confirm with the client</summary>
              <ul className="mt-1 ml-4 text-xs text-gray-600 list-disc">
                {[...byKind.entries()].map(([kind, list]) => <li key={kind}>{FLAG_LABELS[kind]} ({list.length}): {list.slice(0, 5).map(f => f.zip ?? f.label).join(', ')}{list.length > 5 ? '…' : ''}</li>)}
              </ul>
            </details>
          )}
          {!review.loading && <button onClick={p.onRecheck} className="mt-1 text-xs text-green-700 hover:text-green-800">Check again with Claude</button>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function QuoteResult({ quote, account, holding, holdResult, selected, onToggle, onPlaceHolds, unplaced }: {
  quote: MultiMarketQuote
  account: SfdcAccount | null
  holding: boolean
  holdResult: { ok: boolean; message: string } | null
  selected: Set<string>
  onToggle: (id: string) => void
  onPlaceHolds: () => void
  unplaced: string[]
}) {
  const { summary } = quote
  const [openTruck, setOpenTruck] = useState<string | null>(null)
  const short = quote.lines.filter(l => l.missing > 0)
  const chosen = quote.lines.filter(l => selected.has(l.id))
  const chosenTotal = chosen.reduce((s, l) => s + l.total, 0)
  const booked = holdResult?.ok === true

  return (
    <>
      <div className={card}>
        <div className="flex items-baseline">
          <h2 className="text-sm font-semibold text-gray-900">Quote</h2>
          <span className="ml-auto text-2xl font-bold text-gray-900 tabular-nums">{fmtMoney(summary.grandTotal)}</span>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          {summary.markets} markets · {summary.trucksUsed} trucks · {summary.drivers} drivers · pricing: {quote.pricingBasis}
        </p>

        {unplaced.length > 0 && (
          <div className="mb-3 bg-red-50 border border-red-300 rounded-lg px-3 py-2 text-sm text-red-900">
            Not in this quote: {unplaced.join(', ')} (no ZIP we can locate).
          </div>
        )}
        {short.length > 0 && (
          <div className="mb-3 bg-red-50 border border-red-300 rounded-lg px-3 py-2 text-sm text-red-900">
            Not fully covered: {short.map(l => `${l.market} (${l.missing} of ${l.trucks} trucks)`).join(', ')}. See alternatives below.
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>Book</th><th className={th}>Market</th><th className={th}>Dates</th><th className={th}>Schedule</th>
                <th className={th + ' text-right'}>Media</th><th className={th + ' text-right'}>Transport</th><th className={th + ' text-right'}>Total</th>
                <th className={th}>Trucks</th>
              </tr>
            </thead>
            <tbody>
              {quote.lines.map(l => (
                <tr key={l.id} className={selected.has(l.id) ? '' : 'text-gray-400'}>
                  <td className={td}>
                    <input type="checkbox" checked={selected.has(l.id)} disabled={booked || l.missing >= l.trucks} onChange={() => onToggle(l.id)}
                      title={l.missing >= l.trucks ? 'No truck can cover this market' : 'Book this market'} />
                  </td>
                  <td className={td}>{l.market}</td>
                  <td className={td + ' whitespace-nowrap'}>{fmtDate(l.startDate)} – {fmtDate(l.endDate)}</td>
                  <td className={td + ' whitespace-nowrap'}>{l.trucks} × {scheduleLabel(l.daysPerWeek)} × {l.hours}h <span className="text-gray-400">({l.activationDays} days)</span></td>
                  <td className={tdNum}>{fmtMoney(l.media)}</td>
                  <td className={tdNum}>
                    {l.transport.billed > 0 ? fmtMoney(l.transport.billed) : <span className="text-gray-400">{l.transport.outcome === 'ABSORBED' ? 'included' : '—'}</span>}
                  </td>
                  <td className={tdNum + ' font-medium'}>{fmtMoney(l.total)}</td>
                  <td className={td}>
                    {l.assigned.map((a, i) => (
                      <span key={i} className="inline-block mr-2 whitespace-nowrap">
                        #{a.truckNumber}{a.sharedWith && <span className="text-gray-400"> (shared with {a.sharedWith})</span>}
                      </span>
                    ))}
                    {l.missing > 0 && <span className="text-red-700">{l.missing} not covered</span>}
                  </td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className={td} colSpan={4}>Totals</td>
                <td className={tdNum}>{fmtMoney(summary.media)}</td>
                <td className={tdNum}>{summary.transportBilled > 0 ? fmtMoney(summary.transportBilled) : '—'}</td>
                <td className={tdNum + ' font-bold'}>{fmtMoney(summary.grandTotal)}</td>
                <td className={td}></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 text-sm">
          <Fact label="Transport we absorb" value={fmtMoney(summary.transportAbsorbed)} />
          <Fact label="Deadhead miles" value={fmtNum(summary.deadheadMiles)} />
          <Fact label="Trucks used" value={`${summary.trucksUsed} of ${summary.poolSize} available`} />
          <Fact label="Left for other clients" value={`${summary.leftForOthers} trucks`} />
        </div>

        {quote.warnings.length > 0 && (
          <ul className="mt-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-sm text-amber-900 list-disc list-inside">
            {quote.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}

        {holdResult?.ok ? (
          <div className="mt-4 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-800 font-medium">✓ {holdResult.message}</div>
        ) : (
          <>
            <button onClick={onPlaceHolds} disabled={holding || !account || chosen.length === 0}
              className="mt-4 w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg px-6 py-3 text-sm font-medium">
              {!account ? 'Select a client above to place holds'
                : chosen.length === 0 ? 'Select at least one market to book'
                : holding ? 'Re-checking trucks and placing holds…'
                : `Place holds & create Salesforce opportunity — ${chosen.length} of ${quote.lines.length} markets, ${fmtMoney(chosenTotal)}`}
            </button>
            {chosen.length > 0 && chosen.length < quote.lines.length && (
              <p className="mt-1 text-xs text-gray-500">
                The markets not selected stay out of the holds and the opportunity amount, and are listed on the opportunity as quoted but not selected. Booking only some markets re-routes the trucks, so the final amount can differ slightly from this sum.
              </p>
            )}
          </>
        )}
        {holdResult && !holdResult.ok && <div className="mt-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">{holdResult.message}</div>}
      </div>

      {quote.alternatives.length > 0 && (
        <div className={card}>
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Alternatives</h3>
          <ul className="space-y-1.5 text-sm text-gray-800">
            {quote.alternatives.map((a, i) => (
              <li key={i} className="flex gap-2">
                <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 h-fit mt-0.5 ${a.kind === 'CANT_DO' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
                  {a.kind === 'CANT_DO' ? "Can't do" : a.kind === 'FEWER_TRUCKS' ? 'Fewer trucks' : a.kind === 'HOURS_MODEL' ? 'Hours' : 'Start date'}
                </span>
                <span>{a.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={card}>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Routing</h3>
        <p className="text-xs text-gray-500 mb-2">Where each truck goes. A shared truck alternates between its two markets each week, with a travel day between.</p>
        <ul className="divide-y divide-gray-100">
          {quote.itineraries.map(t => (
            <li key={t.truckNumber} className="py-1.5">
              <button onClick={() => setOpenTruck(o => (o === t.truckNumber ? null : t.truckNumber))} className="w-full flex items-center text-left text-sm">
                <span className="font-medium text-gray-900 w-20">#{t.truckNumber}</span>
                <span className="flex-1 text-gray-700">{t.stops.map(s => s.markets.join(' + ')).join(' → ')}</span>
                <span className="text-xs text-gray-400">{t.drivers} driver{t.drivers === 1 ? '' : 's'}</span>
              </button>
              {openTruck === t.truckNumber && (
                <div className="ml-20 mt-1 text-xs text-gray-600 space-y-0.5">
                  {t.stops.map((stop, i) => {
                    const move = t.moves[i]
                    return (
                      <div key={i}>
                        {move && <>{i === 0 ? 'From' : 'Then from'} {move.from}: {fmtNum(move.miles)} mi{move.transportDays > 0 ? `, ${move.transportDays} travel day${move.transportDays === 1 ? '' : 's'}` : ''}. </>}
                        {stop.markets.join(' + ')}, {fmtDate(stop.start)} – {fmtDate(stop.end)}
                        {stop.hopRoadMiles ? ` (weekly hop ${stop.hopRoadMiles} mi)` : ''}
                      </div>
                    )
                  })}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-gray-100 rounded-lg px-3 py-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="font-semibold text-gray-900 tabular-nums">{value}</div>
    </div>
  )
}

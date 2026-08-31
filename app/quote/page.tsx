'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Navbar } from '@/components/Navbar'

// ---------------------------------------------------------------------------
// Types (mirrors client-side QuoteResponse)
// ---------------------------------------------------------------------------

type QuoteResponse = {
  availability: { requested: number; available: number; local: number; nearby: number; repositioning: number; sufficient: boolean }
  pricing: { dailyRate: number; effectiveDailyRate: number; hourSurcharge: number; truckDays: number; days: number; calendarDays: number; truckCount: number; baseMedia: number; pricingBasis: string; marketSizeTier: { id: number; label: string }; schedule: { daysPerWeek: number; operatingHours: number; activationDays: number } }
  features: {
    shadowFencing: { included: boolean; cost: number; floored: boolean; digitalImpressions: number }
    smartDirectional: { included: boolean; cost: number }
    deviceId: { included: boolean; cost: number }
    studies: { available: boolean; selected: string[]; costPerStudy: number; estimatedImpressions: number; reachMinimum: number }
  }
  transport: { outcome: string; charge?: number; absorbed?: boolean; absorbedReason?: string; repositioning?: { truckCount: number; charge: number; trucks: { distanceMiles: number; transportDays: number; charge: number; from: string }[] }; localCount?: number }
  market: string
  activeTier: string
  mediaTotal: number
  transportCharge: number
  grandTotal: number
  presets: { good: { total: number }; better: { total: number }; best: { total: number; available: boolean; reason?: string } }
  insufficient?: boolean
  message?: string
  selectedTrucks?: string[]
}

type SfdcAccount = { id: string; name: string }

type FeatureToggles = { shadowFencing: boolean; smartDirectional: boolean; deviceId: boolean; studies: string[] }

const VALID_STUDIES = ['web_lift', 'foot_traffic', 'sales_lift', 'brand_lift'] as const
const STUDY_LABELS: Record<string, string> = { web_lift: 'Web Lift', foot_traffic: 'Foot Traffic', sales_lift: 'Sales Lift', brand_lift: 'Brand Lift' }

function fmtMoney(n: number): string { return '$' + Math.round(n).toLocaleString('en-US') }
function todayStr(): string { return new Date().toISOString().split('T')[0] }

// ---------------------------------------------------------------------------
// SFDC Account Search
// ---------------------------------------------------------------------------

function AccountSearch({ selected, onSelect }: { selected: SfdcAccount | null; onSelect: (a: SfdcAccount | null) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SfdcAccount[]>([])
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState(false)
  const debounceRef = useRef<NodeJS.Timeout>()

  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (q.length < 2) { setResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/sfdc/accounts?q=${encodeURIComponent(q)}`)
        const data = await res.json()
        setResults(data.accounts || [])
      } catch { setResults([]) }
      finally { setSearching(false) }
    }, 300)
  }, [])

  if (selected) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm font-medium text-green-800">
          {selected.name}
          <span className="text-green-500 text-xs ml-2">{selected.id}</span>
        </div>
        <button onClick={() => onSelect(null)} className="text-xs text-gray-500 hover:text-gray-700">Change</button>
      </div>
    )
  }

  return (
    <div className="relative">
      <input
        type="text"
        placeholder="Search Salesforce Accounts..."
        value={query}
        onChange={(e) => { setQuery(e.target.value); search(e.target.value); setOpen(true) }}
        onFocus={() => results.length > 0 && setOpen(true)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
      />
      {searching && <span className="absolute right-3 top-2.5 text-xs text-gray-400">Searching...</span>}
      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {results.map((a) => (
            <button
              key={a.id}
              onClick={() => { onSelect(a); setQuery(''); setOpen(false) }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 border-b border-gray-100 last:border-0"
            >
              <span className="font-medium text-gray-900">{a.name}</span>
              <span className="text-gray-400 text-xs ml-2">{a.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function InternalQuotePage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login')
  }, [status, router])

  // SFDC Account
  const [account, setAccount] = useState<SfdcAccount | null>(null)

  // Quote form
  const [form, setForm] = useState({ market: '', start_date: '', end_date: '', truck_count: undefined as number | undefined, days_per_week: 5 as 5 | 6 | 7, operating_hours: 8 as 8 | 10 | 12 })
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteResult, setQuoteResult] = useState<QuoteResponse | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [marketCandidates, setMarketCandidates] = useState<string[] | null>(null)

  // Features
  const [toggles, setToggles] = useState<FeatureToggles>({ shadowFencing: true, smartDirectional: false, deviceId: false, studies: [] })

  // Hold
  const [holdLoading, setHoldLoading] = useState(false)
  const [holdResult, setHoldResult] = useState<{ ok: boolean; message: string } | null>(null)

  const quoteRef = useRef<HTMLDivElement>(null)

  const submitQuote = useCallback(async () => {
    const { market, start_date, end_date, truck_count } = form
    if (quoteLoading || !market.trim() || !start_date || !end_date || !truck_count) return

    setQuoteLoading(true)
    setQuoteError(null)
    setQuoteResult(null)
    setHoldResult(null)
    setMarketCandidates(null)

    try {
      const res = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, truck_count }),
      })
      const data = await res.json()

      if (res.ok && data.insufficient) {
        setQuoteError(data.message)
      } else if (res.ok) {
        setQuoteResult(data)
        if (data.market) setForm(prev => ({ ...prev, market: data.market }))
        setToggles({ shadowFencing: true, smartDirectional: false, deviceId: false, studies: [] })
        setTimeout(() => quoteRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
      } else if (data.error === 'DISAMBIGUATION_REQUIRED') {
        setMarketCandidates(data.candidates)
      } else {
        setQuoteError(data.error || 'Failed to generate quote')
      }
    } catch {
      setQuoteError('Network error.')
    } finally {
      setQuoteLoading(false)
    }
  }, [quoteLoading, form])

  const placeHold = useCallback(async () => {
    if (holdLoading || !quoteResult || !account) return
    setHoldLoading(true)

    const { pricing, features } = quoteResult
    let mediaTotal = pricing.baseMedia
    if (toggles.shadowFencing) mediaTotal += features.shadowFencing.cost
    if (toggles.smartDirectional) mediaTotal += features.smartDirectional.cost
    if (toggles.deviceId) mediaTotal += features.deviceId.cost
    if (features.studies.available && toggles.studies.length > 0) mediaTotal += toggles.studies.length * features.studies.costPerStudy
    const transportCharge = quoteResult.transportCharge
    const grandTotal = mediaTotal + transportCharge

    const tierLabel = !toggles.shadowFencing && !toggles.smartDirectional && !toggles.deviceId && toggles.studies.length === 0 ? 'Good'
      : toggles.shadowFencing && !toggles.smartDirectional && !toggles.deviceId && toggles.studies.length === 0 ? 'Better'
      : toggles.shadowFencing && toggles.studies.length > 0 && features.studies.available ? 'Best' : 'Custom'

    try {
      const res = await fetch('/api/quote/hold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market: quoteResult.market || form.market,
          state: (quoteResult.market || form.market).split(',')[1]?.trim(),
          start_date: form.start_date,
          end_date: form.end_date,
          truck_count: form.truck_count,
          sfdc_account_id: account.id,
          sfdc_account_name: account.name,
          pricing_tier: tierLabel,
          quoted_total: grandTotal,
          daily_rate: pricing.dailyRate,
          features: JSON.stringify({ dailyRate: pricing.dailyRate, truckDays: pricing.truckDays, baseMedia: pricing.baseMedia, shadowFencing: toggles.shadowFencing ? features.shadowFencing.cost : 0, smartDirectional: toggles.smartDirectional ? features.smartDirectional.cost : 0, deviceId: toggles.deviceId ? features.deviceId.cost : 0, studies: toggles.studies, studyCost: features.studies.costPerStudy, transportCharge }),
          transport_charge: transportCharge,
        }),
      })
      const data = await res.json()
      setHoldResult({ ok: res.ok, message: data.message || data.error || 'Unknown error' })
    } catch {
      setHoldResult({ ok: false, message: 'Network error.' })
    } finally {
      setHoldLoading(false)
    }
  }, [holdLoading, quoteResult, account, form, toggles])

  if (status === 'loading' || !session) return null

  const inputClass = 'border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent w-full'
  const complete = Boolean(form.market.trim() && form.start_date && form.end_date && form.truck_count && form.truck_count > 0)
  const calDays = form.start_date && form.end_date ? Math.round((new Date(form.end_date + 'T00:00:00Z').getTime() - new Date(form.start_date + 'T00:00:00Z').getTime()) / 86400000) + 1 : 0

  return (
    <div className="flex flex-col min-h-screen bg-gray-50">
      <Navbar />

      <div className="flex-1 max-w-4xl mx-auto w-full px-4 py-6 sm:px-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">LED Quote Builder</h1>
        <p className="text-sm text-gray-500 mb-6">Build a quote, select a client, and place a hold — all in one place.</p>

        {/* Step 1: Client selection */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-2">1. Select Client (Salesforce Account)</h2>
          <AccountSearch selected={account} onSelect={setAccount} />
        </div>

        {/* Step 2: Campaign details */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">2. Campaign Details</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="col-span-2 sm:col-span-1">
              <label className="text-xs font-medium text-gray-600 mb-1 block">Market</label>
              <input type="text" placeholder="e.g. Dallas, TX" value={form.market} onChange={e => setForm(p => ({ ...p, market: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Start</label>
              <input type="date" value={form.start_date} min={todayStr()} onChange={e => setForm(p => ({ ...p, start_date: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">End</label>
              <input type="date" value={form.end_date} min={form.start_date || todayStr()} onChange={e => setForm(p => ({ ...p, end_date: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Trucks</label>
              <input type="number" min={1} max={50} placeholder="1" value={form.truck_count ?? ''} onChange={e => setForm(p => ({ ...p, truck_count: e.target.value ? parseInt(e.target.value) : undefined }))} className={inputClass} />
            </div>
          </div>

          {/* Schedule options for long campaigns */}
          {calDays > 6 && (
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-600">Schedule:</span>
                {([5, 6, 7] as const).map(d => (
                  <button key={d} type="button" onClick={() => setForm(p => ({ ...p, days_per_week: d }))}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${form.days_per_week === d ? 'bg-green-700 text-white border-green-700' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
                    {d === 5 ? 'Mon-Fri' : d === 6 ? 'Mon-Sat' : '7 days'}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-600">Hours:</span>
                {([8, 10, 12] as const).map(h => (
                  <button key={h} type="button" onClick={() => setForm(p => ({ ...p, operating_hours: h }))}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${form.operating_hours === h ? 'bg-green-700 text-white border-green-700' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
                    {h} hr
                  </button>
                ))}
              </div>
              <span className="text-xs text-gray-400">{calDays} calendar days</span>
            </div>
          )}

          <button onClick={submitQuote} disabled={quoteLoading || !complete}
            className="mt-4 bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white rounded-xl px-6 py-2.5 text-sm font-semibold transition-colors">
            {quoteLoading ? 'Checking availability...' : 'Get Quote'}
          </button>
        </div>

        {/* Error */}
        {quoteError && <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800 mb-4">{quoteError}</div>}

        {/* Disambiguation */}
        {marketCandidates && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-4 mb-4">
            <p className="text-sm font-medium text-amber-900 mb-2">Which market did you mean?</p>
            <div className="flex flex-wrap gap-2">
              {marketCandidates.map(c => (
                <button key={c} onClick={() => { setForm(p => ({ ...p, market: c })); setMarketCandidates(null); setTimeout(() => submitQuote(), 50) }}
                  className="px-4 py-2 bg-white border border-amber-300 rounded-lg text-sm font-medium text-amber-900 hover:bg-amber-100">
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Quote result */}
        {quoteResult && !quoteLoading && (
          <div ref={quoteRef}>
            {/* Availability */}
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-4">
              <div className="flex items-center gap-2 mb-1">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${quoteResult.availability.sufficient ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
                  {quoteResult.availability.available} trucks available
                </span>
              </div>
              <div className="text-xs text-gray-500 mt-1 space-y-0.5">
                {(quoteResult.availability.local + quoteResult.availability.nearby) > 0 && <p>{quoteResult.availability.local + quoteResult.availability.nearby} local</p>}
                {quoteResult.availability.repositioning > 0 && <p>{quoteResult.availability.repositioning} available with repositioning</p>}
              </div>
              {quoteResult.transport.outcome === 'ABSORBED' && quoteResult.transport.repositioning && quoteResult.transport.repositioning.truckCount > 0 && (
                <div className="mt-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-800">
                  <p className="font-medium">Transport included</p>
                  <p className="text-green-600 mt-0.5">{quoteResult.transport.absorbedReason}</p>
                </div>
              )}
              {quoteResult.transport.outcome === 'BILLED' && quoteResult.transport.repositioning && quoteResult.transport.repositioning.truckCount > 0 && (
                <div className="mt-2 text-xs text-gray-600">
                  <p className="font-medium">Repositioning: {quoteResult.transport.repositioning.truckCount} truck{quoteResult.transport.repositioning.truckCount !== 1 ? 's' : ''} · {fmtMoney(quoteResult.transport.repositioning.charge)}</p>
                  {quoteResult.transport.repositioning.trucks.map((t, i) => (
                    <p key={i} className="text-gray-500 mt-0.5">From {t.from} ({Math.round(t.distanceMiles)}mi, {t.transportDays} day{t.transportDays !== 1 ? 's' : ''}) · {fmtMoney(t.charge)}</p>
                  ))}
                </div>
              )}
            </div>

            {/* Summary line */}
            <div className="text-xs text-gray-500 mb-3">
              {quoteResult.pricing.truckCount} truck{quoteResult.pricing.truckCount === 1 ? '' : 's'} × {quoteResult.pricing.days} activation day{quoteResult.pricing.days === 1 ? '' : 's'}
              {quoteResult.pricing.calendarDays !== quoteResult.pricing.days ? ` (${quoteResult.pricing.calendarDays} cal days, ${quoteResult.pricing.schedule.daysPerWeek === 5 ? 'Mon-Fri' : quoteResult.pricing.schedule.daysPerWeek === 6 ? 'Mon-Sat' : '7 days'})` : ''}
              {' = '}{quoteResult.pricing.truckDays} truck-days · {fmtMoney(quoteResult.pricing.dailyRate)}/truck-day
              {quoteResult.pricing.schedule.operatingHours > 8 ? ` · ${quoteResult.pricing.schedule.operatingHours}hr` : ''}
            </div>

            {/* Presets */}
            <div className="grid grid-cols-3 gap-2 mb-4">
              {[
                { name: 'Good', total: quoteResult.presets.good.total, color: 'green', onClick: () => setToggles({ shadowFencing: false, smartDirectional: false, deviceId: false, studies: [] }) },
                { name: 'Better', total: quoteResult.presets.better.total, color: 'blue', onClick: () => setToggles({ shadowFencing: true, smartDirectional: false, deviceId: false, studies: [] }) },
                { name: 'Best', total: quoteResult.presets.best.total, color: 'purple', available: quoteResult.presets.best.available, onClick: () => setToggles({ shadowFencing: true, smartDirectional: false, deviceId: false, studies: quoteResult.presets.best.available ? [...VALID_STUDIES] : [] }) },
              ].map(p => {
                const isAvailable = p.available !== false
                const active = p.name === 'Good' && !toggles.shadowFencing && !toggles.smartDirectional && !toggles.deviceId && toggles.studies.length === 0
                  || p.name === 'Better' && toggles.shadowFencing && !toggles.smartDirectional && !toggles.deviceId && toggles.studies.length === 0
                  || p.name === 'Best' && toggles.shadowFencing && toggles.studies.length > 0
                const colors: Record<string, string> = { green: 'border-green-300 bg-green-50', blue: 'border-blue-300 bg-blue-50', purple: 'border-purple-300 bg-purple-50' }
                const badges: Record<string, string> = { green: 'bg-green-600', blue: 'bg-blue-600', purple: 'bg-purple-600' }
                return (
                  <button key={p.name} onClick={isAvailable ? p.onClick : undefined} disabled={!isAvailable}
                    className={`text-left rounded-xl border-2 p-3 transition-all ${isAvailable ? colors[p.color] : 'border-gray-200 bg-gray-50 opacity-60'} ${active ? 'ring-2 ring-offset-1 ring-green-500' : ''} ${isAvailable ? 'hover:shadow-md cursor-pointer' : 'cursor-not-allowed'}`}>
                    <span className={`text-[10px] font-bold text-white px-2 py-0.5 rounded-full ${isAvailable ? badges[p.color] : 'bg-gray-400'}`}>{p.name}</span>
                    <div className={`text-lg font-bold mt-1.5 ${isAvailable ? 'text-gray-900' : 'text-gray-400'}`}>{fmtMoney(p.total)}</div>
                    {quoteResult.transportCharge > 0 && <div className="text-[10px] text-gray-400">+ transport</div>}
                  </button>
                )
              })}
            </div>

            {/* Feature toggles */}
            <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3 mb-4">
              <h3 className="text-sm font-semibold text-gray-900">Customize features</h3>
              {[
                { key: 'shadowFencing' as const, label: 'Shadow Fencing', desc: 'Geo-targeted digital ads', cost: quoteResult.features.shadowFencing.cost },
                { key: 'smartDirectional' as const, label: 'Smart Directional', desc: 'GPS-triggered directional messaging', cost: quoteResult.features.smartDirectional.cost },
                { key: 'deviceId' as const, label: 'Device ID Passback', desc: 'Audience device data for retargeting', cost: quoteResult.features.deviceId.cost },
              ].map(f => (
                <div key={f.key} className="flex items-center justify-between gap-4">
                  <div><p className="text-sm font-medium text-gray-900">{f.label}</p><p className="text-xs text-gray-500">{f.desc}</p></div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-xs text-gray-500 font-medium">{fmtMoney(f.cost)}</span>
                    <button type="button" role="switch" aria-checked={toggles[f.key]} onClick={() => setToggles(p => ({ ...p, [f.key]: !p[f.key] }))}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${toggles[f.key] ? 'bg-green-600' : 'bg-gray-200'}`}>
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow ${toggles[f.key] ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>
                </div>
              ))}
              <div className="pt-2 border-t border-gray-100">
                <div className="flex items-center justify-between mb-2">
                  <div><p className="text-sm font-medium text-gray-900">Lift Studies</p><p className="text-xs text-gray-500">{fmtMoney(quoteResult.features.studies.costPerStudy)} per study</p></div>
                  {!quoteResult.features.studies.available && <span className="text-[10px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">Requires {quoteResult.features.studies.reachMinimum.toLocaleString()}+ impressions</span>}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {VALID_STUDIES.map(s => {
                    const sel = toggles.studies.includes(s)
                    const can = quoteResult.features.studies.available
                    return (
                      <button key={s} onClick={() => can && setToggles(p => ({ ...p, studies: sel ? p.studies.filter(x => x !== s) : [...p.studies, s] }))} disabled={!can}
                        className={`text-left text-xs rounded-lg border px-3 py-2 transition-all ${sel ? 'border-purple-300 bg-purple-50 text-purple-800 font-medium' : can ? 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50' : 'border-gray-100 bg-gray-50 text-gray-400 cursor-not-allowed'}`}>
                        <span className="mr-1.5">{sel ? '\u2713' : '\u25CB'}</span>{STUDY_LABELS[s]}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* Pricing summary */}
            {(() => {
              const { pricing, features } = quoteResult
              let mediaTotal = pricing.baseMedia
              if (toggles.shadowFencing) mediaTotal += features.shadowFencing.cost
              if (toggles.smartDirectional) mediaTotal += features.smartDirectional.cost
              if (toggles.deviceId) mediaTotal += features.deviceId.cost
              if (features.studies.available && toggles.studies.length > 0) mediaTotal += toggles.studies.length * features.studies.costPerStudy
              const transport = quoteResult.transportCharge
              const total = mediaTotal + transport

              return (
                <div className="bg-white border border-gray-200 rounded-xl p-4">
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between text-gray-600"><span>Base media ({pricing.truckDays} truck-days)</span><span>{fmtMoney(pricing.baseMedia)}</span></div>
                    {toggles.shadowFencing && <div className="flex justify-between text-gray-600"><span>Shadow fencing</span><span>+ {fmtMoney(features.shadowFencing.cost)}</span></div>}
                    {toggles.smartDirectional && <div className="flex justify-between text-gray-600"><span>Smart Directional</span><span>+ {fmtMoney(features.smartDirectional.cost)}</span></div>}
                    {toggles.deviceId && <div className="flex justify-between text-gray-600"><span>Device ID Passback</span><span>+ {fmtMoney(features.deviceId.cost)}</span></div>}
                    {toggles.studies.length > 0 && features.studies.available && <div className="flex justify-between text-gray-600"><span>{toggles.studies.length} lift {toggles.studies.length === 1 ? 'study' : 'studies'}</span><span>+ {fmtMoney(toggles.studies.length * features.studies.costPerStudy)}</span></div>}
                    {transport > 0 && <div className="flex justify-between text-gray-600 pt-1.5 border-t border-gray-100"><span>Transport</span><span>+ {fmtMoney(transport)}</span></div>}
                    <div className="flex justify-between font-bold text-gray-900 pt-2 border-t border-gray-200 text-base"><span>Total</span><span>{fmtMoney(total)}</span></div>
                  </div>

                  {/* Hold button */}
                  {holdResult?.ok ? (
                    <div className="mt-4 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-800 font-medium">
                      {'\u2713'} {holdResult.message}
                    </div>
                  ) : (
                    <button onClick={placeHold} disabled={holdLoading || !account || holdResult?.ok === true}
                      className="mt-4 w-full bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white rounded-xl px-6 py-3 text-sm font-semibold transition-colors">
                      {!account ? 'Select a client above to place hold' : holdLoading ? 'Submitting...' : `Place Hold \u2014 ${fmtMoney(total)}`}
                    </button>
                  )}
                  {holdResult && !holdResult.ok && (
                    <div className="mt-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">{holdResult.message}</div>
                  )}
                </div>
              )
            })()}
          </div>
        )}
      </div>
    </div>
  )
}

'use client'

import { MarketInput } from '@/components/MarketInput'
import { BrandInput } from '@/components/BrandInput'
import toast from 'react-hot-toast'
import { ATT_RELEASE_WARNING } from '@/lib/attSoftRules'
import type { OverrideOption } from '@/lib/availabilityEngine'
import { DEFAULT_STAGE, OPEN_STAGES, type OpenStage } from '@/lib/sfdcStages'
import { useState, useRef, useCallback, useEffect } from 'react'
import { DEFAULT_BRAND_MARKUP_PCT, MAX_BRAND_MARKUP_PCT, clampBrandMarkup } from '@/lib/pricing/brandMarkup'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Navbar } from '@/components/Navbar'
import { PlannerTab } from '@/components/PlannerTab'
import { AccountSearch, type SfdcAccount } from '@/components/AccountSearch'

// ---------------------------------------------------------------------------
// Types (mirrors client-side QuoteResponse)
// ---------------------------------------------------------------------------

type QuoteResponse = {
  availability: {
    requested: number; available: number; local: number; nearby: number; repositioning: number; sufficient: boolean
    cannotArrive?: number
    wouldStrandSuccessor?: number
    originFellBackToGps?: number
    gpsFallbackMarkets?: string[]
    excluded?: { truckNumber: string; from: string; reason: string; detail: string }[]
    requiresOverride?: OverrideOption[]
  }
  pricing: { quoteOnlyRequired?: boolean; brandMarkupPct?: number; clientType?: string | null; dailyRate: number; effectiveDailyRate: number; hourSurcharge: number; truckDays: number; days: number; calendarDays: number; truckCount: number; baseMedia: number; pricingBasis: string; marketSizeTier: { id: number; label: string }; schedule: { daysPerWeek: number; operatingHours: number; activationDays: number } }
  features: {
    shadowFencing: { included: boolean; cost: number; floored: boolean; digitalImpressions: number }
    smartDirectional: { included: boolean; cost: number }
    deviceId: { included: boolean; cost: number }
    studies: { available: boolean; selected: string[]; costPerStudy: number; estimatedImpressions: number; reachMinimum: number }
  }
  transport: { outcome: string; charge?: number; absorbed?: boolean; absorbedReason?: string; repositioning?: { truckCount: number; charge: number; trucks: { distanceMiles: number; transportDays: number; charge: number; from: string }[] }; localCount?: number }
  _internal?: { chainFlags?: { truckNumber: string; successorMarket: string; successorStart: string; deltaTransportDays: number; deltaCost: number }[] }
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


type FeatureToggles = { shadowFencing: boolean; smartDirectional: boolean; deviceId: boolean; studies: string[] }

const VALID_STUDIES = ['web_lift', 'foot_traffic', 'sales_lift', 'brand_lift'] as const
const STUDY_LABELS: Record<string, string> = { web_lift: 'Web Lift', foot_traffic: 'Foot Traffic', sales_lift: 'Sales Lift', brand_lift: 'Brand Lift' }

const EXCLUSION_LABELS: Record<string, string> = {
  CANNOT_ARRIVE:      'Cannot arrive in time',
  STRANDS_SUCCESSOR:  'Would strand a later booking',
  UNKNOWN_ORIGIN:     'No known location',
  BOOKED:             'Already booked',
}

function fmtMoney(n: number): string { return '$' + Math.round(n).toLocaleString('en-US') }
function todayStr(): string { return new Date().toISOString().split('T')[0] }

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function InternalQuotePage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login')
  }, [status, router])

  // Tab state
  const [activeTab, setActiveTab] = useState<'builder' | 'classic' | 'planner'>('builder')

  // SFDC Account
  const [account, setAccount] = useState<SfdcAccount | null>(null)
  // Brand Direct accounts carry a premium on media; the seller can change it.
  const [brandMarkupPct, setBrandMarkupPct] = useState<number>(DEFAULT_BRAND_MARKUP_PCT)
  // Opportunity stage the seller wants the reservation's opportunity to start at.
  const [stage, setStage] = useState<OpenStage>(DEFAULT_STAGE)
  // The campaign's brand, for the Salesforce opportunity (components/BrandInput.tsx).
  const [brand, setBrand] = useState('')
  // Low conviction: log a priced opportunity without reserving any truck.
  const [quoteOnly, setQuoteOnly] = useState(false)
  const isBrandDirect = account?.clientType === 'Brand Direct'
  const markupPct = isBrandDirect ? clampBrandMarkup(brandMarkupPct) : 0

  // Quote form
  const [form, setForm] = useState({ market: '', start_date: '', end_date: '', truck_count: undefined as number | undefined, days_per_week: 5 as 5 | 6 | 7, operating_hours: 8 as 8 | 10 | 12 })
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteResult, setQuoteResult] = useState<QuoteResponse | null>(null)
  // A markup typed but not yet re-priced: the prices on screen are not the
  // prices that would be booked, so booking waits until they match.
  const markupPending = isBrandDirect && quoteResult !== null && markupPct !== (quoteResult.pricing.brandMarkupPct ?? 0)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  // Internal-only breakdown shown under the headline. Never sent to clients.
  const [quoteErrorDetail, setQuoteErrorDetail] = useState<string | null>(null)
  // Soft-held trucks offered when the quote has too few free trucks.
  const [quoteErrorOverrides, setQuoteErrorOverrides] = useState<OverrideOption[]>([])
  const [marketCandidates, setMarketCandidates] = useState<string[] | null>(null)

  // Features
  const [toggles, setToggles] = useState<FeatureToggles>({ shadowFencing: true, smartDirectional: false, deviceId: false, studies: [] })

  // Hold
  const [holdLoading, setHoldLoading] = useState(false)
  const [holdResult, setHoldResult] = useState<{ ok: boolean; message: string } | null>(null)

  const quoteRef = useRef<HTMLDivElement>(null)

  // `reprice`: the same quote again with a new Brand Direct markup — keep the
  // result and the seller's feature choices on screen while it refreshes.
  const submitQuote = useCallback(async (marketOverride?: string, opts: { reprice?: boolean; quoteOnly?: boolean } = {}) => {
    const market = marketOverride || form.market
    const { start_date, end_date, truck_count } = form
    if (quoteLoading || !market.trim() || !start_date || !end_date || !truck_count) return

    if (marketOverride) setForm(prev => ({ ...prev, market: marketOverride }))
    setQuoteLoading(true)
    setQuoteError(null)
    setQuoteErrorDetail(null)
    if (!opts.reprice) setQuoteResult(null)
    setHoldResult(null)
    setMarketCandidates(null)

    try {
      const res = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, market, truck_count, sfdc_account_id: account?.id, brand_markup_pct: isBrandDirect ? markupPct : undefined, quote_only: opts.quoteOnly || quoteResult?.pricing.quoteOnlyRequired || undefined }),
      })
      const data = await res.json()

      setQuoteErrorOverrides([])
      if (res.ok && data.insufficient) {
        setQuoteError(data.message)
        setQuoteErrorDetail(data.detail ?? null)
        setQuoteErrorOverrides(data.availability?.requiresOverride ?? [])
      } else if (res.ok) {
        setQuoteResult(data)
        if (data.pricing?.quoteOnlyRequired) setQuoteOnly(true)
        if (data.market) setForm(prev => ({ ...prev, market: data.market }))
        if (!opts.reprice) {
          setToggles({ shadowFencing: true, smartDirectional: false, deviceId: false, studies: [] })
          setTimeout(() => quoteRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
        }
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
  }, [quoteLoading, form, account?.id, isBrandDirect, markupPct, quoteResult?.pricing.quoteOnlyRequired])

  // Changing the Brand Direct markup re-prices the quote on the server, so
  // every line on screen is the real, folded-in price.
  const repriceWith = (pct: number) => {
    const next = clampBrandMarkup(pct)
    setBrandMarkupPct(next)
    if (quoteResult && next !== quoteResult.pricing.brandMarkupPct) setRepriceToken(t => t + 1)
  }
  const [repriceToken, setRepriceToken] = useState(0)
  useEffect(() => { if (repriceToken) submitQuote(undefined, { reprice: true }) }, [repriceToken]) // eslint-disable-line react-hooks/exhaustive-deps

  // The total on screen, exactly as the pricing summary adds it up. Sent with
  // the booking so the server refuses a price the rep has not seen.
  const shownTotal = (): number | null => {
    if (!quoteResult) return null
    const { pricing, features } = quoteResult
    let media = pricing.baseMedia
    if (toggles.shadowFencing) media += features.shadowFencing.cost
    if (toggles.smartDirectional) media += features.smartDirectional.cost
    if (toggles.deviceId) media += features.deviceId.cost
    if (features.studies.available && toggles.studies.length > 0) media += toggles.studies.length * features.studies.costPerStudy
    return media + quoteResult.transportCharge
  }

  // Release a truck's AT&T soft hold for THIS booking's dates only, after the
  // operations warning, then re-quote so the truck can be used.
  const [releasing, setReleasing] = useState<string | null>(null)
  const releaseForBooking = async (truckNumber: string) => {
    if (!form.start_date || !form.end_date) return
    if (!confirm(ATT_RELEASE_WARNING)) return
    setReleasing(truckNumber)
    try {
      const res = await fetch('/api/holds/att-soft/release', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          truck_number: truckNumber, start_date: form.start_date, end_date: form.end_date,
          context: `Quote: ${account?.name ?? 'no client'}, ${quoteResult?.market || form.market}, ${form.start_date} to ${form.end_date}`,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Release failed')
      toast.success(data.message)
      submitQuote()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Release failed')
    } finally {
      setReleasing(null)
    }
  }

  const placeHold = useCallback(async (expectedOverride?: number) => {
    if (holdLoading || !quoteResult || !account) return
    setHoldLoading(true)

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
          brand,
          shadow_fencing: toggles.shadowFencing,
          smart_directional: toggles.smartDirectional,
          device_id: toggles.deviceId,
          studies: toggles.studies,
          // Server re-checks the account is Brand Direct before applying it.
          brand_markup_pct: isBrandDirect ? markupPct : undefined,
          stage,
          quote_only: quoteOnly,
          days_per_week: form.days_per_week,
          operating_hours: form.operating_hours,
          expected_total: expectedOverride ?? shownTotal(),
        }),
      })
      const data = await res.json()
      if (res.status === 409 && data.priceChanged) {
        setHoldLoading(false)
        const ok = confirm(`The price on fresh data is ${fmtMoney(data.priceChanged.now)}, not ${fmtMoney(data.priceChanged.was)} as shown.\n\nBook at ${fmtMoney(data.priceChanged.now)}?`)
        if (ok) return placeHold(data.priceChanged.now)
        setHoldResult({ ok: false, message: 'Nothing was booked. Re-quote to see the current price.' })
        return
      }
      setHoldResult({ ok: res.ok, message: data.message || data.error || 'Unknown error' })
    } catch {
      setHoldResult({ ok: false, message: 'Network error.' })
    } finally {
      setHoldLoading(false)
    }
  }, [holdLoading, quoteResult, account, form, toggles, isBrandDirect, markupPct, stage, quoteOnly, brand]) // eslint-disable-line react-hooks/exhaustive-deps

  if (status === 'loading' || !session) return null

  const inputClass = 'border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent w-full'
  const complete = Boolean(account && form.market.trim() && form.start_date && form.end_date && form.truck_count && form.truck_count > 0)
  const calDays = form.start_date && form.end_date ? Math.round((new Date(form.end_date + 'T00:00:00Z').getTime() - new Date(form.start_date + 'T00:00:00Z').getTime()) / 86400000) + 1 : 0

  return (
    <div className="flex flex-col min-h-dvh bg-gray-50">
      <Navbar />

      <div className="flex-1 max-w-4xl mx-auto w-full px-4 py-6 sm:px-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">LED Quote</h1>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-gray-200">
          <button
            onClick={() => setActiveTab('builder')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'builder' ? 'border-green-600 text-green-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            Quote Builder
          </button>
          <button
            onClick={() => setActiveTab('planner')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'planner' ? 'border-green-600 text-green-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            Multi-market Plan
          </button>
          <button
            onClick={() => setActiveTab('classic')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'classic' ? 'border-green-600 text-green-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            Classic Quote Tool
          </button>
        </div>

        {activeTab === 'planner' ? (
          <PlannerTab />
        ) : activeTab === 'classic' ? (
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden" style={{ minHeight: 'calc(100vh - 200px)' }}>
            <iframe
              src="/led-quote-generator.html"
              className="w-full border-0"
              style={{ minHeight: 'calc(100vh - 200px)' }}
              title="LED Quote Generator"
            />
          </div>
        ) : (
        <>

        {/* Step 1: Client selection */}
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 mb-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-2">1. Select Client (Salesforce Account)</h2>
          <AccountSearch selected={account} onSelect={(a) => { setAccount(a); setBrandMarkupPct(DEFAULT_BRAND_MARKUP_PCT); setQuoteResult(null); setHoldResult(null) }} />
          <div className="mt-3 max-w-sm">
            <BrandInput value={brand} onChange={setBrand} className={inputClass} />
          </div>
        </div>

        {/* Step 2: Campaign details */}
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 mb-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">2. Campaign Details</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="col-span-2 sm:col-span-1">
              <label className="text-xs font-medium text-gray-600 mb-1 block">Market</label>
              <MarketInput value={form.market} onChange={v => setForm(p => ({ ...p, market: v }))} className={inputClass} ariaLabel="Market" />
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

          {/* Hours are chosen for every campaign. The weekly schedule only for
              7+ days: a shorter range runs, and is billed, every day it covers. */}
          <div className="mt-3 flex flex-wrap items-center gap-4">
            {calDays > 6 ? (
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-600">Schedule:</span>
                {([5, 6, 7] as const).map(d => (
                  <button key={d} type="button" onClick={() => setForm(p => ({ ...p, days_per_week: d }))}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${form.days_per_week === d ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                    {d === 5 ? 'Mon-Fri' : d === 6 ? 'Mon-Sat' : '7 days'}
                  </button>
                ))}
              </div>
            ) : calDays > 0 ? (
              <span className="text-xs text-gray-500">Runs every day: {calDays} day{calDays === 1 ? '' : 's'}</span>
            ) : null}
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-gray-600">Hours:</span>
              {([8, 10, 12] as const).map(h => (
                <button key={h} type="button" onClick={() => setForm(p => ({ ...p, operating_hours: h }))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${form.operating_hours === h ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                  {h} hr
                </button>
              ))}
            </div>
            {calDays > 6 && <span className="text-xs text-gray-400">{calDays} calendar days</span>}
          </div>

          <button onClick={() => submitQuote()} disabled={quoteLoading || !complete}
            className="mt-4 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg px-6 py-2.5 text-sm font-medium transition-colors">
            {quoteLoading ? 'Checking availability...' : 'Get Quote'}
          </button>
        </div>

        {/* Error — headline first, internal detail underneath (staff view only) */}
        {quoteError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-4">
            <p className="text-sm font-medium text-red-900">{quoteError}</p>
            {quoteErrorDetail && (
              <p className="text-xs text-red-700 mt-1">{quoteErrorDetail}</p>
            )}
            {/* Not enough trucks: it can still be priced and logged as a quote, reserving nothing. */}
            {quoteErrorDetail && (
              <button type="button" onClick={() => submitQuote(undefined, { quoteOnly: true })} disabled={quoteLoading}
                className="mt-2 rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-900 hover:bg-red-100 disabled:opacity-50">
                Price it anyway (quote only, no reservation)
              </button>
            )}
            {quoteErrorOverrides.length > 0 && (
              <SoftHoldReleaseOptions options={quoteErrorOverrides} releasing={releasing} onRelease={releaseForBooking} />
            )}
          </div>
        )}

        {/* Disambiguation */}
        {marketCandidates && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-4 mb-4">
            <p className="text-sm font-medium text-amber-900 mb-2">Which market did you mean?</p>
            <div className="flex flex-wrap gap-2">
              {marketCandidates.map(c => (
                <button key={c} onClick={() => submitQuote(c)}
                  className="px-4 py-2 bg-white border border-amber-200 rounded-lg text-sm font-medium text-amber-900 hover:bg-amber-100 transition-colors">
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
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 mb-4">
              <div className="flex items-center gap-2 mb-1">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${quoteResult.availability.sufficient ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
                  {quoteResult.availability.available} trucks available
                </span>
              </div>
              <div className="text-xs text-gray-500 mt-1 space-y-0.5">
                {(quoteResult.availability.local + quoteResult.availability.nearby) > 0 && <p>{quoteResult.availability.local + quoteResult.availability.nearby} local</p>}
                {quoteResult.availability.repositioning > 0 && <p>{quoteResult.availability.repositioning} available with repositioning</p>}
              </div>

              {/* Trucks ruled out by logistics — shown so thin availability
                  reads as a constraint, not an empty fleet. */}
              {(quoteResult.availability.excluded?.length ?? 0) > 0 && (
                <details className="mt-2 group">
                  <summary className="cursor-pointer text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 list-none flex items-center justify-between">
                    <span className="font-medium">
                      {quoteResult.availability.excluded!.length} truck{quoteResult.availability.excluded!.length !== 1 ? 's' : ''} ruled out
                      {(quoteResult.availability.cannotArrive ?? 0) > 0 && ` · ${quoteResult.availability.cannotArrive} can't arrive in time`}
                      {(quoteResult.availability.wouldStrandSuccessor ?? 0) > 0 && ` · ${quoteResult.availability.wouldStrandSuccessor} would strand a later booking`}
                    </span>
                    <span className="text-amber-600 ml-2 group-open:rotate-180 transition-transform">&#9662;</span>
                  </summary>
                  <ul className="mt-1.5 space-y-1">
                    {quoteResult.availability.excluded!.map((t) => (
                      <li key={t.truckNumber} className="text-xs text-gray-600 px-3">
                        <span className="font-medium text-gray-800">Truck {t.truckNumber}</span>
                        <span className="text-gray-400"> · {t.from}</span>
                        <span className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600">
                          {EXCLUSION_LABELS[t.reason] ?? t.reason}
                        </span>
                        <p className="text-gray-500 mt-0.5">{t.detail}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {/* Available only by displacing a soft hold — a rep decision. */}
              {(quoteResult.availability.requiresOverride?.length ?? 0) > 0 && (
                <SoftHoldReleaseOptions options={quoteResult.availability.requiresOverride!} releasing={releasing} onRelease={releaseForBooking} />
              )}

              {/* Data quality: a prior job's market did not geocode, so those
                  trucks were priced from live GPS — the old, wrong basis. */}
              {(quoteResult.availability.originFellBackToGps ?? 0) > 0 && (
                <div className="mt-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-800">
                  <p className="font-medium">
                    {quoteResult.availability.originFellBackToGps} truck{quoteResult.availability.originFellBackToGps !== 1 ? 's' : ''} priced from GPS, not their prior job
                  </p>
                  <p className="text-red-600 mt-0.5">
                    Unrecognized market{(quoteResult.availability.gpsFallbackMarkets?.length ?? 0) !== 1 ? 's' : ''}:{' '}
                    {quoteResult.availability.gpsFallbackMarkets?.join('; ')}. Transport for these may be wrong — verify before sending.
                  </p>
                </div>
              )}

              {/* Internal: deadhead this booking adds to each truck's next job.
                  Flagged only — never added to the quoted price. */}
              {(quoteResult._internal?.chainFlags?.length ?? 0) > 0 && (
                <div className="mt-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-600">
                  <p className="font-medium text-gray-700">Internal &middot; downstream impact (not billed)</p>
                  {quoteResult._internal!.chainFlags!.map((f) => (
                    <p key={f.truckNumber} className="mt-0.5">
                      Truck {f.truckNumber} &rarr; {f.successorMarket} on {f.successorStart}:{' '}
                      {f.deltaTransportDays > 0 ? '+' : ''}{f.deltaTransportDays} transport day{Math.abs(f.deltaTransportDays) !== 1 ? 's' : ''}
                      {f.deltaCost !== 0 && ` · ${f.deltaCost > 0 ? '+' : '-'}${fmtMoney(Math.abs(f.deltaCost))}`}
                    </p>
                  ))}
                </div>
              )}
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

            {/* Brand Direct — internal only. The markup is folded into every
                price below; the client never sees it as a line. */}
            {isBrandDirect && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-purple-200 bg-purple-50 px-3 py-2 text-xs text-purple-900">
                <span className="font-semibold">Brand Direct pricing</span>
                <label className="flex items-center gap-1">
                  +
                  <input type="number" min={0} max={MAX_BRAND_MARKUP_PCT} step={0.5} value={brandMarkupPct}
                    onChange={e => setBrandMarkupPct(e.target.value === '' ? 0 : Number(e.target.value))}
                    onBlur={() => repriceWith(brandMarkupPct)}
                    onKeyDown={e => { if (e.key === 'Enter') repriceWith(brandMarkupPct) }}
                    aria-label="Brand Direct markup percent"
                    className="w-16 border border-purple-200 rounded px-1.5 py-0.5 text-right text-sm bg-white focus:outline-none focus:ring-2 focus:ring-purple-400" />
                  %
                </label>
                <span className="text-purple-700">included in every price below, transport too. Not shown to the client.</span>
                {quoteLoading && <span className="text-purple-500">Updating…</span>}
              </div>
            )}

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
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 space-y-3 mb-4">
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
                <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between text-gray-600"><span>Base media ({pricing.truckDays} truck-days)</span><span>{fmtMoney(pricing.baseMedia)}</span></div>
                    {toggles.shadowFencing && <div className="flex justify-between text-gray-600"><span>Shadow fencing</span><span>+ {fmtMoney(features.shadowFencing.cost)}</span></div>}
                    {toggles.smartDirectional && <div className="flex justify-between text-gray-600"><span>Smart Directional</span><span>+ {fmtMoney(features.smartDirectional.cost)}</span></div>}
                    {toggles.deviceId && <div className="flex justify-between text-gray-600"><span>Device ID Passback</span><span>+ {fmtMoney(features.deviceId.cost)}</span></div>}
                    {toggles.studies.length > 0 && features.studies.available && <div className="flex justify-between text-gray-600"><span>{toggles.studies.length} lift {toggles.studies.length === 1 ? 'study' : 'studies'}</span><span>+ {fmtMoney(toggles.studies.length * features.studies.costPerStudy)}</span></div>}
                    {transport > 0 && <div className="flex justify-between text-gray-600 pt-1.5 border-t border-gray-100"><span>Transport</span><span>+ {fmtMoney(transport)}</span></div>}
                    <div className="flex justify-between font-bold text-gray-900 pt-2 border-t border-gray-200 text-base"><span>Total</span><span>{fmtMoney(total)}</span></div>
                  </div>

                  {/* Opportunity stage — open stages only */}
                  {!holdResult?.ok && (
                    <div className="mt-4 flex items-center gap-2 text-xs">
                      <span className="font-medium text-gray-600">Opportunity stage</span>
                      <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5" role="radiogroup" aria-label="Opportunity stage">
                        {OPEN_STAGES.map(s => (
                          <button key={s.value} type="button" role="radio" aria-checked={stage === s.value} onClick={() => setStage(s.value)}
                            className={`px-3 py-1 rounded-md font-medium transition-colors ${stage === s.value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {!holdResult?.ok && (
                    <label className="mt-2 flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
                      <input type="checkbox" checked={quoteOnly || !!quoteResult.pricing.quoteOnlyRequired} disabled={!!quoteResult.pricing.quoteOnlyRequired}
                        onChange={e => { setQuoteOnly(e.target.checked); setHoldResult(null) }} className="mt-0.5 rounded" />
                      <span><span className="font-medium">Log quote only, no reservation</span>: creates the priced Salesforce opportunity but reserves no trucks (for low-conviction quotes).
                        {quoteResult.pricing.quoteOnlyRequired && <span className="block text-amber-800">Not enough trucks are free for these dates, so this can only be logged as a quote.</span>}
                      </span>
                    </label>
                  )}

                  {/* Hold button */}
                  {holdResult?.ok ? (
                    <div className="mt-4 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-800 font-medium">
                      {'\u2713'} {holdResult.message}
                    </div>
                  ) : (
                    <button onClick={() => placeHold()} disabled={holdLoading || quoteLoading || markupPending || !account || holdResult?.ok === true}
                      className="mt-4 w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg px-6 py-3 text-sm font-medium transition-colors">
                      {!account ? 'Select a client above to place hold' : markupPending ? 'Update the price for the new markup first' : holdLoading ? 'Submitting...'
                        : quoteOnly ? `Log quote in Salesforce (no reservation) \u2014 ${fmtMoney(total)}`
                        : `Place Hold \u2014 ${fmtMoney(total)}`}
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

        </>
        )}
      </div>
    </div>
  )
}

/**
 * Trucks this quote can use only by overriding an AT&T soft hold, closest
 * first. A soft hold on the booking's dates is released for those dates only
 * (after the operations warning); a truck whose only problem is a LATER soft
 * hold it would strand cannot be freed by that release, so it gets no button.
 */
function SoftHoldReleaseOptions({ options, releasing, onRelease }: {
  options: OverrideOption[]
  releasing: string | null
  onRelease: (truckNumber: string) => void
}) {
  const releasable = options.filter(t => t.releasable).length
  return (
    <div className="mt-2 bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 text-xs text-purple-800">
      <p className="font-medium">
        {options.length} truck{options.length !== 1 ? 's' : ''} held for AT&amp;T {options.length !== 1 ? 'are' : 'is'} not in this quote
      </p>
      {releasable > 0 && (
        <p className="text-purple-600 mt-0.5">
          Release the soft hold for this booking&apos;s dates to use {releasable !== 1 ? 'them' : 'it'}; the quote re-runs with the truck included.
        </p>
      )}
      {options.map((t) => (
        <div key={t.truckNumber} className="mt-1.5 flex items-start gap-2">
          <p className="flex-1 text-purple-600">
            <span className="font-medium">Truck {t.truckNumber}</span> ({t.from}, {t.needsTransport ? `${t.distanceMiles} mi, needs transport` : 'in market, no transport'}) — {t.detail}
            {!t.releasable && ' Releasing these dates would not free it; check with operations.'}
          </p>
          {t.releasable && (
            <button type="button" disabled={releasing === t.truckNumber}
              onClick={() => onRelease(t.truckNumber)}
              className="shrink-0 rounded border border-purple-300 bg-white px-2 py-0.5 font-medium text-purple-800 hover:bg-purple-100 disabled:opacity-50">
              {releasing === t.truckNumber ? 'Releasing…' : 'Release for this booking'}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

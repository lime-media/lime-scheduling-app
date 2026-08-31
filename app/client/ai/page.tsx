'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { ClientHeader } from '@/components/ClientHeader'
import { useClientAuth, hasAiAssistantAccess } from '@/lib/useClientAuth'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type QuoteResponse = {
  availability: {
    requested: number
    available: number
    local: number
    nearby: number
    repositioning: number
    sufficient: boolean
  }
  pricing: {
    dailyRate: number
    effectiveDailyRate: number
    hourSurcharge: number
    truckDays: number
    days: number
    calendarDays: number
    truckCount: number
    baseMedia: number
    pricingBasis: string
    marketSizeTier: { id: number; label: string; dailyA18: number }
    schedule: { daysPerWeek: number; operatingHours: number; activationDays: number }
  }
  features: {
    shadowFencing: { included: boolean; cost: number; floored: boolean; digitalImpressions: number }
    smartDirectional: { included: boolean; cost: number }
    deviceId: { included: boolean; cost: number }
    studies: { available: boolean; selected: string[]; costPerStudy: number; estimatedImpressions: number; reachMinimum: number }
  }
  transport: {
    outcome: string
    charge?: number
    reason?: string
    absorbed?: boolean
    absorbedReason?: string
    repositioning?: { truckCount: number; charge: number; trucks: { distanceMiles: number; transportDays: number; charge: number; from: string }[] }
    localCount?: number
    depositRequired?: boolean
    depositAmount?: number
  }
  market: string
  activeTier: string
  mediaTotal: number
  transportCharge: number
  grandTotal: number
  presets: {
    good: { total: number; description: string }
    better: { total: number; description: string }
    best: { total: number; description: string; available: boolean; reason?: string }
  }
}

type FeatureToggles = {
  shadowFencing: boolean
  smartDirectional: boolean
  deviceId: boolean
  studies: string[]
}

type HoldResult = {
  ok: boolean
  message: string
  created?: number
  failed?: number
}

type Message = {
  role: 'user' | 'assistant'
  content: string
}

type QuoteForm = {
  market: string
  start_date: string
  end_date: string
  truck_count: number | undefined
  days_per_week: 5 | 6 | 7
  operating_hours: 8 | 10 | 12
}

const VALID_STUDIES = ['web_lift', 'foot_traffic', 'sales_lift', 'brand_lift'] as const
const STUDY_LABELS: Record<string, string> = {
  web_lift: 'Web Lift',
  foot_traffic: 'Foot Traffic',
  sales_lift: 'Sales Lift',
  brand_lift: 'Brand Lift',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtMoney(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

function getTierLabel(toggles: FeatureToggles, studiesAvailable: boolean): string {
  const { shadowFencing, smartDirectional, deviceId, studies } = toggles
  if (!shadowFencing && !smartDirectional && !deviceId && studies.length === 0) return 'Good'
  if (shadowFencing && !smartDirectional && !deviceId && studies.length === 0) return 'Better'
  if (shadowFencing && studies.length > 0 && studiesAvailable) return 'Best'
  return 'Custom'
}

// ---------------------------------------------------------------------------
// Availability Summary
// ---------------------------------------------------------------------------

function AvailabilitySummary({ data }: { data: QuoteResponse }) {
  const { availability, transport } = data

  const triggerLabels: Record<string, string> = {
    SHORT_FLIGHT: 'short campaign',
    RUSH: 'rush lead time',
  }

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-4">
      <div className="flex items-center gap-2 mb-1">
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
          availability.sufficient ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'
        }`}>
          {availability.available} truck{availability.available !== 1 ? 's' : ''} available
        </span>
        {!availability.sufficient && (
          <span className="text-xs text-amber-600">
            (requested {availability.requested})
          </span>
        )}
      </div>

      {/* Truck breakdown */}
      <div className="text-xs text-gray-500 mt-1.5 space-y-0.5">
        {(availability.local > 0 || availability.nearby > 0) && (
          <p>{availability.local + availability.nearby} local (no transport cost)</p>
        )}
        {availability.repositioning > 0 && (
          <p>{availability.repositioning} available with repositioning</p>
        )}
      </div>

      {/* Transport summary */}
      {transport.outcome === 'MANUAL_QUOTE' && (
        <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">
          {transport.reason}
        </div>
      )}
      {transport.outcome === 'ABSORBED' && transport.repositioning && transport.repositioning.truckCount > 0 && (
        <div className="mt-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-800">
          <p className="font-medium">Transport included</p>
          <p className="text-green-600 mt-0.5">{transport.absorbedReason}</p>
          <p className="text-green-600 mt-0.5">
            {transport.repositioning.truckCount} truck{transport.repositioning.truckCount !== 1 ? 's' : ''} repositioning from out of market
          </p>
        </div>
      )}
      {transport.outcome === 'BILLED' && transport.repositioning && transport.repositioning.truckCount > 0 && (
        <div className="mt-2 text-xs text-gray-600">
          <p className="font-medium">
            Repositioning: {transport.repositioning.truckCount} truck{transport.repositioning.truckCount !== 1 ? 's' : ''} &middot; {fmtMoney(transport.repositioning.charge)}
          </p>
          <div className="mt-1 space-y-0.5 text-gray-500">
            {transport.repositioning.trucks.map((t, i) => (
              <p key={i}>
                From {t.from} ({Math.round(t.distanceMiles)}mi, {t.transportDays} travel day{t.transportDays !== 1 ? 's' : ''}) &middot; {fmtMoney(t.charge)}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Interactive Quote Card
// ---------------------------------------------------------------------------

function InteractiveQuoteCard({
  data,
  toggles,
  onToggle,
  onPlaceHold,
  holdResult,
  holdLoading,
}: {
  data: QuoteResponse
  toggles: FeatureToggles
  onToggle: (update: Partial<FeatureToggles>) => void
  onPlaceHold: () => void
  holdResult: HoldResult | null
  holdLoading: boolean
}) {
  const { pricing, features } = data

  // Client-side price recalculation from component costs
  let mediaTotal = pricing.baseMedia
  if (toggles.shadowFencing) mediaTotal += features.shadowFencing.cost
  if (toggles.smartDirectional) mediaTotal += features.smartDirectional.cost
  if (toggles.deviceId) mediaTotal += features.deviceId.cost
  if (features.studies.available && toggles.studies.length > 0) {
    mediaTotal += toggles.studies.length * features.studies.costPerStudy
  }
  const transportCharge = data.transportCharge
  const grandTotal = mediaTotal + transportCharge

  const tierLabel = getTierLabel(toggles, features.studies.available)

  // Tier preset click handlers
  const setGood = () => onToggle({ shadowFencing: false, smartDirectional: false, deviceId: false, studies: [] })
  const setBetter = () => onToggle({ shadowFencing: true, smartDirectional: false, deviceId: false, studies: [] })
  const setBest = () => onToggle({
    shadowFencing: true,
    smartDirectional: false,
    deviceId: false,
    studies: features.studies.available ? [...VALID_STUDIES] : [],
  })

  const presets = [
    { name: 'Good', total: data.presets.good.total, desc: data.presets.good.description, onClick: setGood, color: 'green', active: tierLabel === 'Good' },
    { name: 'Better', total: data.presets.better.total, desc: data.presets.better.description, onClick: setBetter, color: 'blue', active: tierLabel === 'Better' },
    { name: 'Best', total: data.presets.best.total, desc: data.presets.best.description, onClick: setBest, color: 'purple', active: tierLabel === 'Best', available: data.presets.best.available, reason: data.presets.best.reason },
  ]

  const colorMap: Record<string, { border: string; bg: string; ring: string; badge: string }> = {
    green:  { border: 'border-green-300', bg: 'bg-green-50', ring: 'ring-green-500', badge: 'bg-green-600' },
    blue:   { border: 'border-blue-300', bg: 'bg-blue-50', ring: 'ring-blue-500', badge: 'bg-blue-600' },
    purple: { border: 'border-purple-300', bg: 'bg-purple-50', ring: 'ring-purple-500', badge: 'bg-purple-600' },
  }

  return (
    <div className="max-w-3xl mx-auto">
      {/* Summary line */}
      <div className="text-xs text-gray-500 mb-3 px-1">
        {pricing.truckCount} truck{pricing.truckCount === 1 ? '' : 's'} &times; {pricing.days} activation day{pricing.days === 1 ? '' : 's'}
        {pricing.calendarDays !== pricing.days ? ` (${pricing.calendarDays} calendar days, ${pricing.schedule.daysPerWeek === 5 ? 'Mon-Fri' : pricing.schedule.daysPerWeek === 6 ? 'Mon-Sat' : '7 days'})` : ''}
        {' = '}{pricing.truckDays} truck-day{pricing.truckDays === 1 ? '' : 's'} &middot; {fmtMoney(pricing.dailyRate)}/truck-day
        {pricing.schedule.operatingHours > 8 ? ` · ${pricing.schedule.operatingHours}hr days` : ''}
        {pricing.pricingBasis !== 'standard' ? ' · negotiated rate' : ''}
      </div>

      {/* Tier presets */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        {presets.map((p) => {
          const c = colorMap[p.color]
          const isAvailable = p.available !== false
          return (
            <button
              key={p.name}
              type="button"
              onClick={isAvailable ? p.onClick : undefined}
              disabled={!isAvailable}
              className={`text-left rounded-xl border-2 p-3 transition-all ${
                isAvailable ? `${c.border} ${c.bg}` : 'border-gray-200 bg-gray-50 opacity-60'
              } ${p.active ? `ring-2 ring-offset-1 ${c.ring}` : ''} ${
                isAvailable ? 'hover:shadow-md hover:-translate-y-0.5 cursor-pointer' : 'cursor-not-allowed'
              }`}
            >
              <span className={`text-[10px] font-bold text-white px-2 py-0.5 rounded-full ${isAvailable ? c.badge : 'bg-gray-400'}`}>
                {p.name}
              </span>
              <div className={`text-lg font-bold mt-1.5 ${isAvailable ? 'text-gray-900' : 'text-gray-400'}`}>
                {fmtMoney(p.total)}
              </div>
              {transportCharge > 0 && (
                <div className="text-[10px] text-gray-400">+ transport</div>
              )}
              <div className="text-xs text-gray-500 mt-0.5">{p.desc}</div>
              {!isAvailable && p.reason && (
                <p className="text-[10px] text-gray-400 mt-1.5 leading-tight">{p.reason}</p>
              )}
            </button>
          )
        })}
      </div>

      {/* Feature toggles */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          Customize features
          {tierLabel !== 'Custom' ? (
            <span className={`text-[10px] font-bold text-white px-2 py-0.5 rounded-full ${
              tierLabel === 'Good' ? 'bg-green-600' : tierLabel === 'Better' ? 'bg-blue-600' : 'bg-purple-600'
            }`}>
              {tierLabel}
            </span>
          ) : (
            <span className="text-[10px] font-semibold text-gray-500 px-2 py-0.5 rounded-full bg-gray-100">Custom</span>
          )}
        </h3>

        {/* Shadow Fencing */}
        <FeatureToggle
          label="Shadow Fencing"
          description={`Geo-targeted digital ads${features.shadowFencing.floored ? ' (floor applied)' : ''} · ${Math.round(features.shadowFencing.digitalImpressions).toLocaleString('en-US')} digital impressions`}
          cost={features.shadowFencing.cost}
          checked={toggles.shadowFencing}
          onChange={(v) => onToggle({ shadowFencing: v })}
        />

        {/* Smart Directional */}
        <FeatureToggle
          label="Smart Directional"
          description="GPS-triggered directional messaging"
          cost={features.smartDirectional.cost}
          checked={toggles.smartDirectional}
          onChange={(v) => onToggle({ smartDirectional: v })}
        />

        {/* Device ID Passback */}
        <FeatureToggle
          label="Device ID Passback"
          description="Audience device data for retargeting"
          cost={features.deviceId.cost}
          checked={toggles.deviceId}
          onChange={(v) => onToggle({ deviceId: v })}
        />

        {/* Lift Studies */}
        <div className="pt-2 border-t border-gray-100">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-sm font-medium text-gray-900">Lift Studies</p>
              <p className="text-xs text-gray-500">{fmtMoney(features.studies.costPerStudy)} per study</p>
            </div>
            {!features.studies.available && (
              <span className="text-[10px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                Requires {(features.studies.reachMinimum).toLocaleString('en-US')}+ impressions
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {VALID_STUDIES.map((study) => {
              const isSelected = toggles.studies.includes(study)
              const canSelect = features.studies.available
              return (
                <button
                  key={study}
                  type="button"
                  onClick={() => {
                    if (!canSelect) return
                    onToggle({
                      studies: isSelected
                        ? toggles.studies.filter((s) => s !== study)
                        : [...toggles.studies, study],
                    })
                  }}
                  disabled={!canSelect}
                  className={`text-left text-xs rounded-lg border px-3 py-2 transition-all ${
                    isSelected
                      ? 'border-purple-300 bg-purple-50 text-purple-800 font-medium'
                      : canSelect
                        ? 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                        : 'border-gray-100 bg-gray-50 text-gray-400 cursor-not-allowed'
                  }`}
                >
                  <span className="mr-1.5">{isSelected ? '\u2713' : '\u25CB'}</span>
                  {STUDY_LABELS[study] || study}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Pricing summary */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 mt-3">
        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between text-gray-600">
            <span>Base media ({pricing.truckDays} truck-days)</span>
            <span>{fmtMoney(pricing.baseMedia)}</span>
          </div>
          {toggles.shadowFencing && (
            <div className="flex justify-between text-gray-600">
              <span>Shadow fencing</span>
              <span>+ {fmtMoney(features.shadowFencing.cost)}</span>
            </div>
          )}
          {toggles.smartDirectional && (
            <div className="flex justify-between text-gray-600">
              <span>Smart Directional</span>
              <span>+ {fmtMoney(features.smartDirectional.cost)}</span>
            </div>
          )}
          {toggles.deviceId && (
            <div className="flex justify-between text-gray-600">
              <span>Device ID Passback</span>
              <span>+ {fmtMoney(features.deviceId.cost)}</span>
            </div>
          )}
          {toggles.studies.length > 0 && features.studies.available && (
            <div className="flex justify-between text-gray-600">
              <span>{toggles.studies.length} lift {toggles.studies.length === 1 ? 'study' : 'studies'}</span>
              <span>+ {fmtMoney(toggles.studies.length * features.studies.costPerStudy)}</span>
            </div>
          )}
          {transportCharge > 0 && (
            <div className="flex justify-between text-gray-600 pt-1.5 border-t border-gray-100">
              <span>Transport</span>
              <span>+ {fmtMoney(transportCharge)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold text-gray-900 pt-2 border-t border-gray-200 text-base">
            <span>Total</span>
            <span>{fmtMoney(grandTotal)}</span>
          </div>
        </div>

        {/* Place Hold button */}
        {holdResult?.ok ? (
          <div className="mt-4 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-800 font-medium">
            <span className="mr-1">{'\u2713'}</span>
            {holdResult.message}
          </div>
        ) : (
          <button
            onClick={onPlaceHold}
            disabled={holdLoading || holdResult?.ok === true}
            className="mt-4 w-full bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white rounded-xl px-6 py-3 text-sm font-semibold transition-colors"
          >
            {holdLoading ? 'Submitting...' : `Place Hold \u2014 ${fmtMoney(grandTotal)}`}
          </button>
        )}
        {holdResult && !holdResult.ok && (
          <div className="mt-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
            <span className="mr-1">{'\u2717'}</span>
            {holdResult.message}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Feature Toggle Switch
// ---------------------------------------------------------------------------

function FeatureToggle({
  label,
  description,
  cost,
  checked,
  onChange,
}: {
  label: string
  description: string
  cost: number
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900">{label}</p>
        <p className="text-xs text-gray-500 truncate">{description}</p>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <span className="text-xs text-gray-500 font-medium">{fmtMoney(cost)}</span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          onClick={() => onChange(!checked)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            checked ? 'bg-green-600' : 'bg-gray-200'
          }`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`} />
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Quote Box
// ---------------------------------------------------------------------------

function QuoteBox({
  form,
  onChange,
  onSubmit,
  disabled,
}: {
  form: QuoteForm
  onChange: (p: Partial<QuoteForm>) => void
  onSubmit: () => void
  disabled: boolean
}) {
  const complete = Boolean(form.market.trim() && form.start_date && form.end_date && form.truck_count && form.truck_count > 0)
  const inputClass = 'border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent w-full'
  const labelClass = 'text-xs font-medium text-gray-600 mb-1'
  const requiredMark = <span className="text-red-500">&nbsp;*</span>

  return (
    <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-5 sm:px-6 sm:py-6">
      <div className="max-w-3xl mx-auto">
        <h2 className="text-base sm:text-lg font-bold text-gray-900">Get a quote</h2>
        <p className="text-xs sm:text-sm text-gray-500 mt-0.5 mb-4">
          Enter your campaign details — we&apos;ll check availability and price it out below.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="col-span-2 sm:col-span-1">
            <label className={labelClass}>Market{requiredMark}</label>
            <input
              type="text"
              placeholder="e.g. Dallas, TX"
              value={form.market}
              onChange={(e) => onChange({ market: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Start date{requiredMark}</label>
            <input
              type="date"
              value={form.start_date}
              min={todayStr()}
              onChange={(e) => onChange({ start_date: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>End date{requiredMark}</label>
            <input
              type="date"
              value={form.end_date}
              min={form.start_date || todayStr()}
              onChange={(e) => onChange({ end_date: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Trucks{requiredMark}</label>
            <input
              type="number"
              min={1}
              max={50}
              placeholder="1"
              value={form.truck_count ?? ''}
              onChange={(e) => onChange({ truck_count: e.target.value ? parseInt(e.target.value, 10) : undefined })}
              className={inputClass}
            />
          </div>
        </div>
        {/* Schedule options — shown when campaign is longer than 6 days */}
        {form.start_date && form.end_date && (() => {
          const calDays = Math.round((new Date(form.end_date + 'T00:00:00Z').getTime() - new Date(form.start_date + 'T00:00:00Z').getTime()) / 86400000) + 1
          if (calDays <= 6) return null
          const btnClass = (active: boolean) =>
            `px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              active ? 'bg-green-700 text-white border-green-700' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
            }`
          return (
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-600">Schedule:</span>
                <button type="button" className={btnClass(form.days_per_week === 5)} onClick={() => onChange({ days_per_week: 5 })}>Mon-Fri</button>
                <button type="button" className={btnClass(form.days_per_week === 6)} onClick={() => onChange({ days_per_week: 6 })}>Mon-Sat</button>
                <button type="button" className={btnClass(form.days_per_week === 7)} onClick={() => onChange({ days_per_week: 7 })}>7 days</button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-600">Hours:</span>
                <button type="button" className={btnClass(form.operating_hours === 8)} onClick={() => onChange({ operating_hours: 8 })}>8 hr</button>
                <button type="button" className={btnClass(form.operating_hours === 10)} onClick={() => onChange({ operating_hours: 10 })}>10 hr</button>
                <button type="button" className={btnClass(form.operating_hours === 12)} onClick={() => onChange({ operating_hours: 12 })}>12 hr</button>
              </div>
              <span className="text-xs text-gray-400">
                {calDays} calendar days
              </span>
            </div>
          )
        })()}
        <button
          onClick={onSubmit}
          disabled={disabled || !complete}
          data-quote-submit
          title={!complete ? 'Fill in market, start date, end date, and trucks to continue' : undefined}
          className="mt-4 w-full sm:w-auto bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white rounded-xl px-6 py-2.5 text-sm font-semibold transition-colors"
        >
          Get Quote
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function ClientAiPage() {
  const { clientUser, authChecked } = useClientAuth()

  // Quote form state
  const [quoteForm, setQuoteForm] = useState<QuoteForm>({ market: '', start_date: '', end_date: '', truck_count: undefined, days_per_week: 5, operating_hours: 8 })
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteResult, setQuoteResult] = useState<QuoteResponse | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [marketCandidates, setMarketCandidates] = useState<string[] | null>(null)
  const [insufficientInfo, setInsufficientInfo] = useState<{ available: number; requested: number; message: string } | null>(null)
  const [assistRequestSent, setAssistRequestSent] = useState(false)

  // Feature toggles (initialized when quote comes back)
  const [featureToggles, setFeatureToggles] = useState<FeatureToggles>({
    shadowFencing: true,
    smartDirectional: false,
    deviceId: false,
    studies: [],
  })

  // Hold state
  const [holdLoading, setHoldLoading] = useState(false)
  const [holdResult, setHoldResult] = useState<HoldResult | null>(null)

  // Chat state
  const [chatOpen, setChatOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)

  const quoteRef = useRef<HTMLDivElement>(null)
  const chatBottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, chatLoading])

  const updateQuoteForm = useCallback((partial: Partial<QuoteForm>) => {
    setQuoteForm((prev) => ({ ...prev, ...partial }))
  }, [])

  // Direct quote API call
  const submitQuote = useCallback(async () => {
    const { market, start_date, end_date, truck_count } = quoteForm
    if (quoteLoading || !market.trim() || !start_date || !end_date || !truck_count) return

    setQuoteLoading(true)
    setQuoteError(null)
    setQuoteResult(null)
    setHoldResult(null)
    setMarketCandidates(null)
    setInsufficientInfo(null)
    setAssistRequestSent(false)

    try {
      const res = await fetch('/api/client/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market, start_date, end_date, truck_count, days_per_week: quoteForm.days_per_week, operating_hours: quoteForm.operating_hours }),
      })
      const data = await res.json()

      if (res.ok && data.insufficient) {
        setInsufficientInfo({
          available: data.availability.available,
          requested: data.availability.requested,
          message: data.message,
        })
      } else if (res.ok) {
        setQuoteResult(data)
        if (data.market) {
          setQuoteForm((prev) => ({ ...prev, market: data.market }))
        }
        setFeatureToggles({
          shadowFencing: true,
          smartDirectional: false,
          deviceId: false,
          studies: [],
        })
        setTimeout(() => quoteRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
      } else if (data.error === 'DISAMBIGUATION_REQUIRED') {
        setMarketCandidates(data.candidates)
      } else {
        setQuoteError(data.error || 'Failed to generate quote')
      }
    } catch {
      setQuoteError('Network error. Please check your connection.')
    } finally {
      setQuoteLoading(false)
    }
  }, [quoteLoading, quoteForm])

  // Direct hold API call
  const placeHold = useCallback(async () => {
    if (holdLoading || !quoteResult) return

    const { start_date, end_date, truck_count } = quoteForm
    // Use the formalized market name from the quote result
    const market = quoteResult.market || quoteForm.market
    if (!market || !start_date || !end_date || !truck_count) return

    setHoldLoading(true)

    // Compute current total for pricing snapshot
    const { pricing, features } = quoteResult
    let mediaTotal = pricing.baseMedia
    if (featureToggles.shadowFencing) mediaTotal += features.shadowFencing.cost
    if (featureToggles.smartDirectional) mediaTotal += features.smartDirectional.cost
    if (featureToggles.deviceId) mediaTotal += features.deviceId.cost
    if (features.studies.available && featureToggles.studies.length > 0) {
      mediaTotal += featureToggles.studies.length * features.studies.costPerStudy
    }
    const transportCharge = quoteResult.transportCharge
    const grandTotal = mediaTotal + transportCharge

    const tierLabel = getTierLabel(featureToggles, features.studies.available)

    // Build features JSON snapshot
    const featuresJson = JSON.stringify({
      dailyRate: pricing.dailyRate,
      hourSurcharge: pricing.hourSurcharge,
      truckDays: pricing.truckDays,
      truckCount: pricing.truckCount,
      activationDays: pricing.days,
      calendarDays: pricing.calendarDays,
      daysPerWeek: pricing.schedule.daysPerWeek,
      operatingHours: pricing.schedule.operatingHours,
      baseMedia: pricing.baseMedia,
      shadowFencing: featureToggles.shadowFencing ? features.shadowFencing.cost : 0,
      shadowFencingFloored: features.shadowFencing.floored,
      smartDirectionalIncluded: featureToggles.smartDirectional,
      smartDirectional: featureToggles.smartDirectional ? features.smartDirectional.cost : 0,
      deviceIdIncluded: featureToggles.deviceId,
      deviceId: featureToggles.deviceId ? features.deviceId.cost : 0,
      studies: featureToggles.studies,
      studyCost: features.studies.costPerStudy,
      studiesTotal: features.studies.available ? featureToggles.studies.length * features.studies.costPerStudy : 0,
      transportCharge,
    })

    try {
      const res = await fetch('/api/client/hold-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market,
          state: market.split(',')[1]?.trim() || undefined,
          start_date,
          end_date,
          truck_count,
          pricing_tier: tierLabel,
          quoted_total: grandTotal,
          daily_rate: pricing.dailyRate,
          features: featuresJson,
          transport_charge: transportCharge,
        }),
      })
      const data = await res.json()

      if (res.ok) {
        setHoldResult({ ok: true, message: data.message, created: data.created, failed: data.failed })
      } else {
        setHoldResult({ ok: false, message: data.error || 'Failed to place hold' })
      }
    } catch {
      setHoldResult({ ok: false, message: 'Network error. Please try again.' })
    } finally {
      setHoldLoading(false)
    }
  }, [holdLoading, quoteResult, quoteForm, featureToggles])

  // Chat — conversation only
  const sendChat = useCallback(async (text?: string) => {
    const typed = (text ?? chatInput).trim()
    if (chatLoading || !typed) return

    const userMsg: Message = { role: 'user', content: typed }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setChatInput('')
    setChatLoading(true)

    try {
      const res = await fetch('/api/client/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: typed,
          history: nextMessages.slice(-10),
        }),
      })
      const data = await res.json()

      if (res.ok) {
        const replyContent = data.actionResult
          ? `${data.reply}\n\n${data.actionResult.message}`
          : data.reply
        setMessages([...nextMessages, { role: 'assistant', content: replyContent }])
      } else {
        setMessages([...nextMessages, { role: 'assistant', content: 'Sorry, I encountered an error. Please try again.' }])
      }
    } catch {
      setMessages([...nextMessages, { role: 'assistant', content: 'Network error. Please check your connection.' }])
    } finally {
      setChatLoading(false)
    }
  }, [chatLoading, chatInput, messages])

  const handleChatKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendChat()
    }
  }

  if (!authChecked) return null

  if (!clientUser) {
    return (
      <div className="flex flex-col items-center justify-center h-dvh text-center p-4">
        <div className="text-5xl mb-4">&#128274;</div>
        <p className="text-gray-600 font-medium">Log in to use the assistant</p>
        <Link href="/client/login" className="mt-4 bg-[#1a3028] text-white px-4 py-2 rounded-lg text-sm hover:bg-[#1a3028]/90">
          Log in
        </Link>
      </div>
    )
  }

  if (!hasAiAssistantAccess(clientUser)) {
    return (
      <div className="flex flex-col h-dvh bg-gray-50 overflow-hidden">
        <ClientHeader clientUser={clientUser} authChecked={authChecked} />
        <div className="flex-1 flex flex-col items-center justify-center text-center p-4">
          <div className="text-5xl mb-4">&#128679;</div>
          <p className="text-gray-600 font-medium">The assistant isn&apos;t available on your account yet.</p>
          <Link href="/client" className="mt-4 bg-[#1a3028] text-white px-4 py-2 rounded-lg text-sm hover:bg-[#1a3028]/90">
            Back to Schedule
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-dvh bg-gray-50 overflow-hidden">
      <ClientHeader clientUser={clientUser} authChecked={authChecked} />

      <div className="flex-1 flex flex-col min-h-0">
        {/* Quote Box */}
        <QuoteBox
          form={quoteForm}
          onChange={updateQuoteForm}
          onSubmit={submitQuote}
          disabled={quoteLoading}
        />

        {/* Main content area */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-4 py-6 sm:px-6">
            {/* Loading spinner */}
            {quoteLoading && (
              <div className="max-w-3xl mx-auto flex items-center justify-center py-12">
                <div className="flex gap-1 items-center">
                  <span className="w-2.5 h-2.5 bg-green-500 rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-2.5 h-2.5 bg-green-500 rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-2.5 h-2.5 bg-green-500 rounded-full animate-bounce [animation-delay:300ms]" />
                  <span className="text-sm text-gray-500 ml-3">Checking availability and pricing...</span>
                </div>
              </div>
            )}

            {/* Error */}
            {quoteError && (
              <div className="max-w-3xl mx-auto bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800">
                {quoteError}
              </div>
            )}

            {/* Insufficient availability — submit request to team */}
            {insufficientInfo && (
              <div className="max-w-3xl mx-auto bg-amber-50 border border-amber-200 rounded-xl px-4 py-4">
                <p className="text-sm font-medium text-amber-900 mb-1">{insufficientInfo.message}</p>
                <p className="text-xs text-amber-700 mb-3">
                  {insufficientInfo.available} available / {insufficientInfo.requested} requested
                </p>
                {assistRequestSent ? (
                  <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-800 font-medium">
                    {'\u2713'} Request submitted — the Lime Media team will reach out within 12-24 hours.
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      const { market, start_date, end_date, truck_count } = quoteForm
                      try {
                        const res = await fetch('/api/client/assist', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            market,
                            state: market.split(',')[1]?.trim() || undefined,
                            start_date,
                            end_date,
                            details: `Client needs ${truck_count} trucks in ${market} from ${start_date} to ${end_date}, but only ${insufficientInfo.available} are available. Requesting team assistance to fulfill.`,
                          }),
                        })
                        if (res.ok) setAssistRequestSent(true)
                      } catch { /* fail silently */ }
                    }}
                    className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    Submit Request to Lime Media Team
                  </button>
                )}
              </div>
            )}

            {/* Market disambiguation */}
            {marketCandidates && (
              <div className="max-w-3xl mx-auto bg-amber-50 border border-amber-200 rounded-xl px-4 py-4">
                <p className="text-sm font-medium text-amber-900 mb-2">Which market did you mean?</p>
                <div className="flex flex-wrap gap-2">
                  {marketCandidates.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      onClick={() => {
                        setQuoteForm((prev) => ({ ...prev, market: candidate }))
                        setMarketCandidates(null)
                        // Auto-submit with the selected market
                        setTimeout(() => {
                          const btn = document.querySelector('[data-quote-submit]') as HTMLButtonElement
                          btn?.click()
                        }, 50)
                      }}
                      className="px-4 py-2 bg-white border border-amber-300 rounded-lg text-sm font-medium text-amber-900 hover:bg-amber-100 transition-colors"
                    >
                      {candidate}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Quote result */}
            {quoteResult && !quoteLoading && (
              <div ref={quoteRef}>
                <AvailabilitySummary data={quoteResult} />
                <InteractiveQuoteCard
                  data={quoteResult}
                  toggles={featureToggles}
                  onToggle={(update) => setFeatureToggles((prev) => ({ ...prev, ...update }))}
                  onPlaceHold={placeHold}
                  holdResult={holdResult}
                  holdLoading={holdLoading}
                />
              </div>
            )}

            {/* Empty state */}
            {!quoteResult && !quoteLoading && !quoteError && (
              <div className="max-w-3xl mx-auto text-center py-12 text-gray-400">
                <p className="text-lg mb-1">Enter your campaign details above to get started.</p>
                <p className="text-sm">Or ask a question below.</p>
              </div>
            )}
          </div>
        </div>

        {/* Chat drawer */}
        <div className="flex-shrink-0 border-t border-gray-200 bg-white">
          {/* Toggle */}
          <button
            type="button"
            onClick={() => setChatOpen(!chatOpen)}
            className="w-full px-4 py-2.5 flex items-center justify-between text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <span className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-[#1a3028] flex items-center justify-center text-white text-[9px] font-bold">AI</span>
              Ask a question
            </span>
            <span className={`transition-transform ${chatOpen ? 'rotate-180' : ''}`}>&#9650;</span>
          </button>

          {/* Chat panel */}
          {chatOpen && (
            <div className="border-t border-gray-100">
              {/* Messages */}
              <div className="max-h-64 overflow-y-auto px-4 py-3 space-y-3">
                {messages.length === 0 && (
                  <p className="text-xs text-gray-400 text-center py-4">
                    Ask about availability, your holds, or anything else.
                  </p>
                )}
                {messages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {msg.role === 'assistant' && (
                      <div className="w-6 h-6 rounded-full bg-[#1a3028] flex items-center justify-center text-white text-[9px] font-bold mr-2 flex-shrink-0 mt-0.5">
                        AI
                      </div>
                    )}
                    <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-[#1a3028] text-white rounded-tr-sm'
                        : 'bg-white border border-gray-200 text-gray-800 rounded-tl-sm shadow-sm'
                    }`}>
                      {msg.content}
                    </div>
                  </div>
                ))}

                {chatLoading && (
                  <div className="flex justify-start">
                    <div className="w-6 h-6 rounded-full bg-[#1a3028] flex items-center justify-center text-white text-[9px] font-bold mr-2 flex-shrink-0">
                      AI
                    </div>
                    <div className="bg-white border border-gray-200 rounded-2xl rounded-tl-sm px-3 py-2 shadow-sm">
                      <div className="flex gap-1 items-center">
                        <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
                        <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
                        <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
                      </div>
                    </div>
                  </div>
                )}

                <div ref={chatBottomRef} />
              </div>

              {/* Input */}
              <div className="px-4 py-2 border-t border-gray-100 flex gap-2">
                <textarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={handleChatKeyDown}
                  placeholder="Ask about availability, your holds, or anything else..."
                  rows={1}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                />
                <button
                  onClick={() => sendChat()}
                  disabled={chatLoading || !chatInput.trim()}
                  className="bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white rounded-lg px-3 py-2 text-sm font-medium transition-colors flex-shrink-0"
                >
                  Send
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

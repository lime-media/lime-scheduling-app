'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import toast from 'react-hot-toast'
import { useSession } from 'next-auth/react'
import { Navbar } from '@/components/Navbar'
import { TableSkeleton } from '@/components/LoadingSkeleton'

type SfdcAccount = { id: string; name: string }

type RateAgreement = {
  id: string
  partner_id: string
  sfdc_account_id: string | null
  name: string
  agreement_type: string
  effective_date: string
  expiration_date: string
  rate_overrides: string
  notes: string | null
  created_by: string
  created_at: string
}

const HARDCODED_RATES = {
  daily_rates: { '1_1': 1850, '2_10': 1350, '11_19': 1200, '20_999': 1200 } as Record<string, number>,
  shadow_fencing_pct: 0.25,
  shadow_fencing_floor: 5000,
  smart_directional_daily: 250,
  device_id_flat: 2500,
  study_cost: 7500,
  hour_surcharge: 150,
  service_area_miles: 250,
  transport_day_rate: 750,
  transport_airfare: 350,
  transport_hotel_per_night: 210,
}

const TIER_LABELS: Record<string, string> = {
  '1_1': '1 day',
  '2_10': '2-10 days',
  '11_19': '11-19 days',
  '20_999': '20+ days',
}

const TYPE_BADGE: Record<string, string> = {
  standard:        'bg-gray-100 text-gray-600',
  volume_discount: 'bg-blue-100 text-blue-700',
  flat_rate:       'bg-green-100 text-green-700',
  custom:          'bg-purple-100 text-purple-700',
}

function fmtMoney(n: number): string {
  return '$' + n.toLocaleString('en-US')
}

// ── SFDC Account Search (reused from quote page pattern) ──────────────────
function AccountSearch({ selected, onSelect }: { selected: SfdcAccount | null; onSelect: (a: SfdcAccount | null) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SfdcAccount[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (query.length < 2) { setResults([]); return }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/sfdc/accounts?q=${encodeURIComponent(query)}`)
        if (res.ok) {
          const data = await res.json()
          setResults(data.accounts ?? [])
        }
      } catch { /* ignore */ } finally { setSearching(false) }
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  if (selected) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-900">{selected.name}</span>
        <span className="text-xs text-gray-400">({selected.id})</span>
        <button onClick={() => { onSelect(null); setQuery('') }} className="text-xs text-red-600 hover:text-red-700 ml-1">Change</button>
      </div>
    )
  }

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search Salesforce accounts..."
        className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
      />
      {searching && <p className="text-xs text-gray-400 mt-1">Searching...</p>}
      {results.length > 0 && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {results.map((a) => (
            <button key={a.id} onClick={() => { onSelect(a); setQuery(''); setResults([]) }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 border-b border-gray-100 last:border-0">
              <span className="font-medium">{a.name}</span>
              <span className="text-xs text-gray-400 ml-2">{a.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Form state ────────────────────────────────────────────────────────────
const emptyForm = {
  name: '',
  agreement_type: 'custom',
  effective_date: '',
  expiration_date: '',
  notes: '',
  daily_1_1: '',
  daily_2_10: '',
  daily_11_19: '',
  daily_20_999: '',
  shadow_fencing_pct: '',
  shadow_fencing_floor: '',
  smart_directional_daily: '',
  device_id_flat: '',
  study_cost: '',
  hour_surcharge: '',
  transport_included: false,
  service_area_miles: '',
  transport_day_rate: '',
  transport_airfare: '',
  transport_hotel_per_night: '',
}

type FormState = typeof emptyForm

function formToOverridesJson(form: FormState): string {
  const overrides: Record<string, unknown> = {}
  const dailyRates: Record<string, number> = {}
  if (form.daily_1_1) dailyRates['1_1'] = Number(form.daily_1_1)
  if (form.daily_2_10) dailyRates['2_10'] = Number(form.daily_2_10)
  if (form.daily_11_19) dailyRates['11_19'] = Number(form.daily_11_19)
  if (form.daily_20_999) dailyRates['20_999'] = Number(form.daily_20_999)
  if (Object.keys(dailyRates).length > 0) overrides.daily_rates = dailyRates
  if (form.shadow_fencing_pct) overrides.shadow_fencing_pct = Number(form.shadow_fencing_pct)
  if (form.shadow_fencing_floor) overrides.shadow_fencing_floor = Number(form.shadow_fencing_floor)
  if (form.smart_directional_daily) overrides.smart_directional_daily = Number(form.smart_directional_daily)
  if (form.device_id_flat) overrides.device_id_flat = Number(form.device_id_flat)
  if (form.study_cost) overrides.study_cost = Number(form.study_cost)
  if (form.hour_surcharge) overrides.hour_surcharge = Number(form.hour_surcharge)
  if (form.transport_included) overrides.transport_included = true
  if (form.service_area_miles) overrides.service_area_miles = Number(form.service_area_miles)
  if (form.transport_day_rate) overrides.transport_day_rate = Number(form.transport_day_rate)
  if (form.transport_airfare) overrides.transport_airfare = Number(form.transport_airfare)
  if (form.transport_hotel_per_night) overrides.transport_hotel_per_night = Number(form.transport_hotel_per_night)
  return JSON.stringify(overrides)
}

function overridesJsonToForm(json: string): Partial<FormState> {
  try {
    const o = JSON.parse(json)
    return {
      daily_1_1: o.daily_rates?.['1_1']?.toString() ?? '',
      daily_2_10: o.daily_rates?.['2_10']?.toString() ?? '',
      daily_11_19: o.daily_rates?.['11_19']?.toString() ?? '',
      daily_20_999: o.daily_rates?.['20_999']?.toString() ?? '',
      shadow_fencing_pct: o.shadow_fencing_pct?.toString() ?? '',
      shadow_fencing_floor: o.shadow_fencing_floor?.toString() ?? '',
      smart_directional_daily: o.smart_directional_daily?.toString() ?? '',
      device_id_flat: o.device_id_flat?.toString() ?? '',
      study_cost: o.study_cost?.toString() ?? '',
      hour_surcharge: o.hour_surcharge?.toString() ?? '',
      transport_included: o.transport_included ?? false,
      service_area_miles: o.service_area_miles?.toString() ?? '',
      transport_day_rate: o.transport_day_rate?.toString() ?? '',
      transport_airfare: o.transport_airfare?.toString() ?? '',
      transport_hotel_per_night: o.transport_hotel_per_night?.toString() ?? '',
    }
  } catch {
    return {}
  }
}

export default function RateCardsPage() {
  const { data: session } = useSession()
  const [agreements, setAgreements] = useState<RateAgreement[]>([])
  const [loading, setLoading] = useState(true)
  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingDefault, setEditingDefault] = useState(false)
  const [form, setForm] = useState<FormState>({ ...emptyForm })
  const [sfdcAccount, setSfdcAccount] = useState<SfdcAccount | null>(null)
  const [saving, setSaving] = useState(false)
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set())

  const toggleCard = (id: string) => {
    setExpandedCards(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const isOps = session?.user?.role === 'OPERATIONS'

  const fetchAgreements = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/rate-cards')
      if (res.ok) {
        const data = await res.json()
        setAgreements(data.agreements)
      }
    } catch {
      toast.error('Failed to load rate cards')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAgreements() }, [fetchAgreements])

  // Compute effective standard rates by merging hardcoded defaults with the editable __default__ card
  const std = useMemo(() => {
    const defaultCard = agreements.find(a => a.sfdc_account_id === '__default__')
    if (!defaultCard) return HARDCODED_RATES
    try {
      const o = JSON.parse(defaultCard.rate_overrides)
      return {
        daily_rates: { ...HARDCODED_RATES.daily_rates, ...o.daily_rates },
        shadow_fencing_pct: o.shadow_fencing_pct ?? HARDCODED_RATES.shadow_fencing_pct,
        shadow_fencing_floor: o.shadow_fencing_floor ?? HARDCODED_RATES.shadow_fencing_floor,
        smart_directional_daily: o.smart_directional_daily ?? HARDCODED_RATES.smart_directional_daily,
        device_id_flat: o.device_id_flat ?? HARDCODED_RATES.device_id_flat,
        study_cost: o.study_cost ?? HARDCODED_RATES.study_cost,
        hour_surcharge: o.hour_surcharge ?? HARDCODED_RATES.hour_surcharge,
        service_area_miles: o.service_area_miles ?? HARDCODED_RATES.service_area_miles,
        transport_day_rate: o.transport_day_rate ?? HARDCODED_RATES.transport_day_rate,
        transport_airfare: o.transport_airfare ?? HARDCODED_RATES.transport_airfare,
        transport_hotel_per_night: o.transport_hotel_per_night ?? HARDCODED_RATES.transport_hotel_per_night,
      }
    } catch { return HARDCODED_RATES }
  }, [agreements])

  const openCreate = () => {
    setForm({ ...emptyForm })
    setSfdcAccount(null)
    setEditingId(null)
    setEditingDefault(false)
    setModalMode('create')
  }

  const openEditDefault = () => {
    const defaultCard = agreements.find(a => a.sfdc_account_id === '__default__')
    if (defaultCard) {
      setSfdcAccount(null)
      setForm({
        ...emptyForm,
        name: defaultCard.name,
        agreement_type: defaultCard.agreement_type,
        effective_date: defaultCard.effective_date,
        expiration_date: defaultCard.expiration_date,
        notes: defaultCard.notes ?? '',
        ...overridesJsonToForm(defaultCard.rate_overrides),
      })
      setEditingId(defaultCard.id)
      setModalMode('edit')
    } else {
      // Create new default card
      const nextYear = new Date()
      nextYear.setFullYear(nextYear.getFullYear() + 5)
      setSfdcAccount(null)
      setForm({
        ...emptyForm,
        name: 'Standard Rate Card',
        effective_date: new Date().toISOString().split('T')[0],
        expiration_date: nextYear.toISOString().split('T')[0],
      })
      setEditingId(null)
      setModalMode('create')
    }
    setEditingDefault(true)
  }

  const openEdit = (a: RateAgreement) => {
    setEditingDefault(a.sfdc_account_id === '__default__')
    setSfdcAccount(a.sfdc_account_id && a.sfdc_account_id !== '__default__' ? { id: a.sfdc_account_id, name: a.name.split(' - ')[0] || a.sfdc_account_id } : null)
    setForm({
      ...emptyForm,
      name: a.name,
      agreement_type: a.agreement_type,
      effective_date: a.effective_date,
      expiration_date: a.expiration_date,
      notes: a.notes ?? '',
      ...overridesJsonToForm(a.rate_overrides),
    })
    setEditingId(a.id)
    setModalMode('edit')
  }

  const handleSave = async () => {
    if (!editingDefault && !sfdcAccount) {
      toast.error('Salesforce Account is required')
      return
    }
    if (!form.name || !form.effective_date || !form.expiration_date) {
      toast.error('Name and dates are required')
      return
    }
    setSaving(true)
    try {
      const payload = {
        sfdc_account_id: editingDefault ? '__default__' : sfdcAccount!.id,
        name: form.name,
        agreement_type: form.agreement_type,
        effective_date: form.effective_date,
        expiration_date: form.expiration_date,
        rate_overrides: formToOverridesJson(form),
        notes: form.notes,
      }
      const url = modalMode === 'edit' ? `/api/rate-cards/${editingId}` : '/api/rate-cards'
      const method = modalMode === 'edit' ? 'PUT' : 'POST'
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (res.ok) {
        toast.success(modalMode === 'edit' ? 'Rate card updated' : 'Rate card created')
        setModalMode(null)
        fetchAgreements()
      } else {
        const err = await res.json()
        toast.error(err.error || 'Failed to save')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (a: RateAgreement) => {
    if (!confirm(`Delete rate card "${a.name}"?`)) return
    const res = await fetch(`/api/rate-cards/${a.id}`, { method: 'DELETE' })
    if (res.ok) { toast.success('Rate card deleted'); fetchAgreements() }
    else toast.error('Failed to delete')
  }

  const isActive = (a: RateAgreement) => {
    const now = new Date().toISOString().split('T')[0]
    return a.effective_date <= now && a.expiration_date >= now
  }

  const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent'

  return (
    <div className="flex flex-col min-h-dvh bg-gray-50">
      <Navbar />
      <div className="flex-1 p-4 sm:p-6 max-w-6xl mx-auto w-full">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Rate Cards</h1>
            <p className="text-sm text-gray-500 mt-0.5">Manage client pricing agreements. Clients without a rate card use the standard rates.</p>
          </div>
          {isOps && (
            <button onClick={openCreate} className="px-4 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium transition-colors">
              New Rate Card
            </button>
          )}
        </div>

        {/* Standard Rate Card Reference */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-700">Standard Rate Card (default)</h2>
            {isOps && (
              <button onClick={openEditDefault} className="text-xs font-medium text-green-700 hover:text-green-800">
                Edit Standard Rates
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            {Object.entries(std.daily_rates).map(([key, rate]) => (
              <div key={key} className="bg-gray-50 rounded-lg border border-gray-100 px-3 py-2.5">
                <div className="text-xs text-gray-500">{TIER_LABELS[key] || key}</div>
                <div className="font-semibold text-gray-900">{fmtMoney(rate as number)}<span className="text-xs text-gray-400 font-normal"> /truck/day</span></div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3 text-sm">
            <div className="bg-gray-50 rounded-lg border border-gray-100 px-3 py-2.5">
              <div className="text-xs text-gray-500">Shadow Fencing</div>
              <div className="font-semibold text-gray-900">{std.shadow_fencing_pct * 100}% <span className="text-xs text-gray-400 font-normal">(min {fmtMoney(std.shadow_fencing_floor)})</span></div>
            </div>
            <div className="bg-gray-50 rounded-lg border border-gray-100 px-3 py-2.5">
              <div className="text-xs text-gray-500">Smart Directional</div>
              <div className="font-semibold text-gray-900">{fmtMoney(std.smart_directional_daily)}<span className="text-xs text-gray-400 font-normal"> /truck/day</span></div>
            </div>
            <div className="bg-gray-50 rounded-lg border border-gray-100 px-3 py-2.5">
              <div className="text-xs text-gray-500">Device ID Passback</div>
              <div className="font-semibold text-gray-900">{fmtMoney(std.device_id_flat)}<span className="text-xs text-gray-400 font-normal"> flat</span></div>
            </div>
            <div className="bg-gray-50 rounded-lg border border-gray-100 px-3 py-2.5">
              <div className="text-xs text-gray-500">Lift Study</div>
              <div className="font-semibold text-gray-900">{fmtMoney(std.study_cost)}<span className="text-xs text-gray-400 font-normal"> /study</span></div>
            </div>
            <div className="bg-gray-50 rounded-lg border border-gray-100 px-3 py-2.5">
              <div className="text-xs text-gray-500">Hour Surcharge</div>
              <div className="font-semibold text-gray-900">{fmtMoney(std.hour_surcharge)}<span className="text-xs text-gray-400 font-normal"> /hr over 8</span></div>
            </div>
            <div className="bg-gray-50 rounded-lg border border-gray-100 px-3 py-2.5">
              <div className="text-xs text-gray-500">Transport Day Rate</div>
              <div className="font-semibold text-gray-900">$750<span className="text-xs text-gray-400 font-normal"> /day + airfare + hotel</span></div>
            </div>
            <div className="bg-gray-50 rounded-lg border border-gray-100 px-3 py-2.5">
              <div className="text-xs text-gray-500">Service Area</div>
              <div className="font-semibold text-gray-900">{std.service_area_miles} mi<span className="text-xs text-gray-400 font-normal"> (absorbed 10+ days w/ 10+ day lead)</span></div>
            </div>
          </div>
        </div>

        {/* Agreements List */}
        {loading ? (
          <TableSkeleton />
        ) : agreements.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <p className="font-medium">No custom rate cards</p>
            <p className="text-sm mt-1">All clients are using the standard rate card above.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {agreements.filter(a => a.sfdc_account_id !== '__default__').map((a) => {
              const overrides = (() => { try { return JSON.parse(a.rate_overrides) } catch { return {} } })()
              const active = isActive(a)
              const expanded = expandedCards.has(a.id)
              const dr = (overrides.daily_rates ?? {}) as Record<string, number>
              const o = overrides

              // Tile helper: green border+bg if overridden, gray if inherited
              const Tile = ({ label, val, stdVal, suffix }: { label: string; val: number | undefined; suffix?: string; stdVal: number }) => {
                const isOverridden = val != null
                const display = isOverridden ? val : stdVal
                return (
                  <div className={`rounded-lg border px-3 py-2.5 ${isOverridden ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-100'}`}>
                    <div className="text-xs text-gray-500">{label}</div>
                    <div className={`font-semibold ${isOverridden ? 'text-green-800' : 'text-gray-900'}`}>
                      {typeof display === 'number' && display < 1 ? `${display * 100}%` : fmtMoney(display)}
                      {suffix && <span className="text-xs text-gray-400 font-normal"> {suffix}</span>}
                    </div>
                  </div>
                )
              }

              return (
                <div key={a.id} className={`bg-white rounded-xl border shadow-sm overflow-hidden ${active ? 'border-green-200' : 'border-gray-200 opacity-75'}`}>
                  {/* Header — always visible, clickable to expand */}
                  <button
                    onClick={() => toggleCard(a.id)}
                    className="w-full px-5 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-gray-50/50 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-semibold text-gray-900 truncate">{a.name}</span>
                      <span className={`inline-flex items-center rounded-full text-xs font-medium px-2.5 py-0.5 flex-shrink-0 ${TYPE_BADGE[a.agreement_type] ?? TYPE_BADGE.custom}`}>
                        {a.agreement_type.replace('_', ' ')}
                      </span>
                      {active ? (
                        <span className="inline-flex items-center rounded-full text-xs font-medium px-2.5 py-0.5 bg-green-100 text-green-700 flex-shrink-0">Active</span>
                      ) : (
                        <span className="inline-flex items-center rounded-full text-xs font-medium px-2.5 py-0.5 bg-gray-100 text-gray-500 flex-shrink-0">Inactive</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="text-xs text-gray-400 hidden sm:inline">{a.effective_date} to {a.expiration_date}</span>
                      <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </button>

                  {/* Expanded body — tile layout matching the standard card */}
                  {expanded && (
                    <div className="px-5 pb-5 border-t border-gray-100">
                      <div className="flex items-center justify-between mt-3 mb-3">
                        <span className="text-xs text-gray-400">{a.effective_date} to {a.expiration_date}</span>
                        {isOps && (
                          <div className="flex gap-1.5">
                            <button onClick={(e) => { e.stopPropagation(); openEdit(a) }} className="px-3 py-1.5 border border-gray-200 hover:bg-gray-50 text-gray-600 rounded-lg text-xs font-medium transition-colors">Edit</button>
                            <button onClick={(e) => { e.stopPropagation(); handleDelete(a) }} className="px-3 py-1.5 border border-red-200 hover:bg-red-50 text-red-600 rounded-lg text-xs font-medium transition-colors">Delete</button>
                          </div>
                        )}
                      </div>

                      {/* Daily Rates */}
                      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Daily Rates</div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-4">
                        {(['1_1', '2_10', '11_19', '20_999'] as const).map(tier => (
                          <Tile key={tier} label={TIER_LABELS[tier]} val={dr[tier]} stdVal={std.daily_rates[tier] as number} suffix="/truck/day" />
                        ))}
                      </div>

                      {/* Add-ons */}
                      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Add-ons</div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm mb-4">
                        <Tile label="Shadow Fencing" val={o.shadow_fencing_pct} stdVal={std.shadow_fencing_pct} />
                        <Tile label="SF Floor" val={o.shadow_fencing_floor} stdVal={std.shadow_fencing_floor} suffix="min" />
                        <Tile label="Smart Directional" val={o.smart_directional_daily} stdVal={std.smart_directional_daily} suffix="/truck/day" />
                        <Tile label="Device ID" val={o.device_id_flat} stdVal={std.device_id_flat} suffix="flat" />
                        <Tile label="Lift Study" val={o.study_cost} stdVal={std.study_cost} suffix="/study" />
                        <Tile label="Hour Surcharge" val={o.hour_surcharge} stdVal={std.hour_surcharge} suffix="/hr over 8" />
                      </div>

                      {/* Transport */}
                      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Transport</div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                        <Tile label="Day Rate" val={o.transport_day_rate} stdVal={std.transport_day_rate} suffix="/day" />
                        <Tile label="Airfare" val={o.transport_airfare} stdVal={std.transport_airfare} suffix="one-way" />
                        <Tile label="Hotel" val={o.transport_hotel_per_night} stdVal={std.transport_hotel_per_night} suffix="/night" />
                        <Tile label="Service Area" val={o.service_area_miles} stdVal={std.service_area_miles} suffix="mi" />
                        {o.transport_included && (
                          <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2.5">
                            <div className="text-xs text-gray-500">Transport</div>
                            <div className="font-semibold text-green-800">Always included</div>
                          </div>
                        )}
                      </div>

                      {a.notes && (
                        <p className="text-xs text-gray-500 mt-4 pt-3 border-t border-gray-100">{a.notes}</p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Create / Edit Modal */}
      {modalMode && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-bold text-gray-900">
                {editingDefault ? 'Edit Standard Rate Card' : modalMode === 'edit' ? 'Edit Rate Card' : 'New Rate Card'}
              </h2>
            </div>
            <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1">
              {!editingDefault && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Salesforce Account</label>
                  <AccountSearch selected={sfdcAccount} onSelect={setSfdcAccount} />
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Agreement Name</label>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} placeholder="e.g. Acme 2026 Agreement" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
                  <select value={form.agreement_type} onChange={(e) => setForm({ ...form, agreement_type: e.target.value })} className={`${inputClass} bg-white`}>
                    <option value="custom">Custom</option>
                    <option value="volume_discount">Volume Discount</option>
                    <option value="flat_rate">Flat Rate</option>
                    <option value="standard">Standard</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Effective Date</label>
                  <input type="date" value={form.effective_date} onChange={(e) => setForm({ ...form, effective_date: e.target.value })} className={inputClass} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Expiration Date</label>
                  <input type="date" value={form.expiration_date} onChange={(e) => setForm({ ...form, expiration_date: e.target.value })} className={inputClass} />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-2 mt-2">Daily Rate Overrides</label>
                <p className="text-xs text-gray-400 mb-2">Leave blank to use standard rate.</p>
                <div className="grid grid-cols-2 gap-3">
                  {(['1_1', '2_10', '11_19', '20_999'] as const).map((tier) => (
                    <div key={tier}>
                      <label className="block text-xs text-gray-500 mb-1">{TIER_LABELS[tier]} <span className="text-gray-300">(std: {fmtMoney(std.daily_rates[tier])})</span></label>
                      <input type="number" value={form[`daily_${tier}` as keyof FormState] as string} onChange={(e) => setForm({ ...form, [`daily_${tier}`]: e.target.value })} className={inputClass} placeholder={std.daily_rates[tier].toString()} />
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-2">Add-on Overrides</label>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Shadow Fencing % <span className="text-gray-300">(std: {std.shadow_fencing_pct})</span></label>
                    <input type="number" step="0.01" value={form.shadow_fencing_pct} onChange={(e) => setForm({ ...form, shadow_fencing_pct: e.target.value })} className={inputClass} placeholder={std.shadow_fencing_pct.toString()} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Shadow Fencing Floor <span className="text-gray-300">(std: {fmtMoney(std.shadow_fencing_floor)})</span></label>
                    <input type="number" value={form.shadow_fencing_floor} onChange={(e) => setForm({ ...form, shadow_fencing_floor: e.target.value })} className={inputClass} placeholder={std.shadow_fencing_floor.toString()} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Smart Dir. /truck/day <span className="text-gray-300">(std: {fmtMoney(std.smart_directional_daily)})</span></label>
                    <input type="number" value={form.smart_directional_daily} onChange={(e) => setForm({ ...form, smart_directional_daily: e.target.value })} className={inputClass} placeholder={std.smart_directional_daily.toString()} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Device ID flat <span className="text-gray-300">(std: {fmtMoney(std.device_id_flat)})</span></label>
                    <input type="number" value={form.device_id_flat} onChange={(e) => setForm({ ...form, device_id_flat: e.target.value })} className={inputClass} placeholder={std.device_id_flat.toString()} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Study cost <span className="text-gray-300">(std: {fmtMoney(std.study_cost)})</span></label>
                    <input type="number" value={form.study_cost} onChange={(e) => setForm({ ...form, study_cost: e.target.value })} className={inputClass} placeholder={std.study_cost.toString()} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Hour surcharge <span className="text-gray-300">(std: {fmtMoney(std.hour_surcharge)})</span></label>
                    <input type="number" value={form.hour_surcharge} onChange={(e) => setForm({ ...form, hour_surcharge: e.target.value })} className={inputClass} placeholder={std.hour_surcharge.toString()} />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-2">Transport</label>
                <div className="space-y-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form.transport_included} onChange={(e) => setForm({ ...form, transport_included: e.target.checked })} className="rounded text-green-600" />
                    <span className="text-sm text-gray-700">Transport always included (no repositioning charges)</span>
                  </label>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Day rate <span className="text-gray-300">(std: {fmtMoney(std.transport_day_rate)})</span></label>
                      <input type="number" value={form.transport_day_rate} onChange={(e) => setForm({ ...form, transport_day_rate: e.target.value })} className={inputClass} placeholder={std.transport_day_rate.toString()} />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Airfare <span className="text-gray-300">(std: {fmtMoney(std.transport_airfare)})</span></label>
                      <input type="number" value={form.transport_airfare} onChange={(e) => setForm({ ...form, transport_airfare: e.target.value })} className={inputClass} placeholder={std.transport_airfare.toString()} />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Hotel /night <span className="text-gray-300">(std: {fmtMoney(std.transport_hotel_per_night)})</span></label>
                      <input type="number" value={form.transport_hotel_per_night} onChange={(e) => setForm({ ...form, transport_hotel_per_night: e.target.value })} className={inputClass} placeholder={std.transport_hotel_per_night.toString()} />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Service area radius <span className="text-gray-300">(std: {std.service_area_miles} mi)</span></label>
                    <input type="number" value={form.service_area_miles} onChange={(e) => setForm({ ...form, service_area_miles: e.target.value })} className={inputClass} placeholder={std.service_area_miles.toString()} />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className={`${inputClass} resize-none`} placeholder="Internal notes about this agreement..." />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex gap-3">
              <button onClick={() => setModalMode(null)} className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2.5 text-sm font-medium hover:bg-gray-50 transition-colors">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors">
                {saving ? 'Saving...' : modalMode === 'edit' ? 'Save Changes' : 'Create Rate Card'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

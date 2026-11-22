'use client'

/**
 * The client portal's multi-market quote and booking (POST /api/client/plan/quote
 * and /api/client/plan/hold, lib/clientMultiMarket.ts). Several markets, each
 * with its own dates, trucks, schedule and hours, quoted and booked as one
 * booking. When some trucks can't be covered, the quote shows what fits, at
 * its own price, and that is what Book books: at that total and those trucks
 * per market, or not at all. Any change clears the quote, so Book always books
 * what is on screen.
 */

import { useCallback, useRef, useState } from 'react'
import { MarketInput } from '@/components/MarketInput'
import { BrandInput } from '@/components/BrandInput'
import { APP_TIME_ZONE, centralDate } from '@/lib/dateOnly'
import { FeatureToggle, STUDY_CHOICES, STUDY_LABELS } from '@/components/FeatureToggle'

type Row = { id: string; market: string; startDate: string; endDate: string; trucks: number | undefined; daysPerWeek: 5 | 6 | 7; hours: 8 | 10 | 12 }

type Line = {
  id: string
  market: string
  startDate: string
  endDate: string
  trucks: number
  daysPerWeek: number
  hours: number
  truckDays: number
  requestedTruckDays: number
  firstDay: string | null
  lastDay: string | null
  baseMedia: number
  shadowFencing: number
  smartDirectional: number
  deviceId: number
  /** What each option would cost on this market, chosen or not. */
  optionPrices: { shadowFencing: number; smartDirectional: number; deviceId: number }
  studiesTotal: number
  media: number
  transport: number
  total: number
  missing: number
}
type Studies = { reachOk: boolean; reachMinimum: number; requested: string[]; selected: string[]; prices: Record<string, number>; total: number; uniqueMarkets: number; salesLiftRequested: boolean; warning: string | null }
type View = { lines: Line[]; studies: Studies; total: number }
/** A quote and the order it priced: Book posts these rows and features, never the live form. */
type Quote = { asked: View; short: boolean; fits: View | null; requestId: string; rows: Row[]; features: Features }
type Features = { shadowFencing: boolean; smartDirectional: boolean; deviceId: boolean; studies: string[] }
type RowError = { rowId: string; message: string; candidates?: string[] }

const MAX_MARKETS = 10
const newId = () => Math.random().toString(36).slice(2, 10)
const blankRow = (): Row => ({ id: newId(), market: '', startDate: '', endDate: '', trucks: undefined, daysPerWeek: 5, hours: 8 })
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
const fmt = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const calDays = (r: Row) => (r.startDate && r.endDate ? Math.round((Date.parse(r.endDate) - Date.parse(r.startDate)) / 864e5) + 1 : 0)
const schedule = (dpw: number) => (dpw === 7 ? 'Every day' : dpw === 6 ? 'Mon-Sat' : 'Mon-Fri')
/** A row as the API takes it; a run of 6 days or fewer runs every day. */
const rowBody = (r: Row) => ({ id: r.id, market: r.market, startDate: r.startDate, endDate: r.endDate, trucks: r.trucks, daysPerWeek: calDays(r) > 6 ? r.daysPerWeek : 7, hours: r.hours })
/** When the booking's hold lapses, in Central time as the rest of the portal shows it. */
const heldUntil = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: APP_TIME_ZONE, timeZoneName: 'short' })
}
/** One id per booking attempt, without "_" (lib/clientMultiMarket.ts). */
const requestIdFor = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${newId()}`)

export function ClientMultiMarketQuote() {
  const [rows, setRows] = useState<Row[]>([blankRow(), blankRow()])
  const [features, setFeatures] = useState<Features>({ shadowFencing: true, smartDirectional: false, deviceId: false, studies: [] })
  const [brand, setBrand] = useState('')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<RowError[]>([])
  const [quote, setQuote] = useState<Quote | null>(null)
  const [booking, setBooking] = useState(false)
  const [booked, setBooked] = useState<string | null>(null)
  const [changed, setChanged] = useState<string | null>(null)
  // The current quote request: a reply to an older one (the order changed since) is dropped.
  const quoteSeq = useRef(0)
  // The form is locked while a quote or a booking is in flight, so what's shown is what was priced and booked.
  const busy = loading || booking

  // Any change to the order clears the quote: Book books only what is on screen.
  const clear = () => { quoteSeq.current++; setQuote(null); setBooked(null); setChanged(null); setError(null) }
  const updateRow = (id: string, p: Partial<Row>) => { setRows(rs => rs.map(r => (r.id === id ? { ...r, ...p } : r))); setRowErrors(es => es.filter(e => e.rowId !== id)); clear() }
  const removeRow = (id: string) => { setRows(rs => rs.filter(r => r.id !== id)); setRowErrors(es => es.filter(e => e.rowId !== id)); clear() }

  const complete = rows.length > 0 && rows.every(r => r.market.trim() && r.startDate && r.endDate && r.endDate >= r.startDate && r.trucks && r.trucks > 0)

  const getQuote = useCallback(async (list: Row[] = rows, feats: Features = features) => {
    const seq = ++quoteSeq.current
    const sent = { rows: list, features: feats }
    setLoading(true)
    setError(null)
    setRowErrors([])
    setQuote(null)
    setBooked(null)
    setChanged(null)
    try {
      const res = await fetch('/api/client/plan/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: sent.rows.map(rowBody),
          features: sent.features,
        }),
      })
      const data = await res.json()
      if (seq !== quoteSeq.current) return  // the order changed while this was priced
      if (res.ok) {
        // The server's market names (e.g. "dallas" → "Dallas, TX"), on the quoted rows and the form alike.
        const names = new Map((data.asked?.lines ?? []).map((l: Line) => [l.id, l.market]))
        const named = (rs: Row[]) => rs.map(r => (names.has(r.id) ? { ...r, market: names.get(r.id) as string } : r))
        setQuote({ asked: data.asked, short: data.short, fits: data.fits, requestId: requestIdFor(), rows: named(sent.rows), features: sent.features })
        setRows(named)
      } else {
        setError(data.error || 'Failed to get a quote')
        setRowErrors(Array.isArray(data.rowErrors) ? data.rowErrors : [])
      }
    } catch {
      if (seq === quoteSeq.current) setError('Network error. Please check your connection.')
    } finally {
      // Quotes never overlap (the form is locked while one runs), so this never hides a newer one.
      setLoading(false)
    }
  }, [rows, features])

  // An option or study changed on a quote: priced again at once, as the
  // one-market quote shows its total change (the server prices every market).
  const setFeature = (p: Partial<Features>) => {
    // Locked while a quote or booking is in flight: what's shown is what was priced and booked.
    if (busy) return
    const next = { ...features, ...p }
    setFeatures(next)
    if (quote) getQuote(quote.rows, next)
    else clear()
  }

  const pickCandidate = (rowId: string, name: string) => {
    const list = rows.map(r => (r.id === rowId ? { ...r, market: name } : r))
    setRows(list)
    getQuote(list)
  }

  const book = useCallback(async () => {
    if (!quote?.fits || booking) return
    setBooking(true)
    setError(null)
    try {
      const res = await fetch('/api/client/plan/hold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Exactly what was quoted, never the live form.
          rows: quote.rows.map(rowBody),
          features: quote.features,
          brand,
          notes,
          requestId: quote.requestId,
          expectedTotal: quote.fits.total,
          expectedTrucks: Object.fromEntries(quote.fits.lines.map(l => [l.id, l.trucks])),
        }),
      })
      const data = await res.json()
      if (res.ok) {
        // The booking's one expiry (capped by the earliest market start), as the server set it.
        const until = typeof data.expiresAt === 'string' ? heldUntil(data.expiresAt) : null
        setBooked(until ? `${data.message} Held until ${until}.` : data.message)
      } else if (res.status === 409 && data.fits) {
        // What can be booked moved since the quote: show it, and book only on a new click.
        // The note and the card both come from this reply, so they describe the same order.
        setQuote(q => (q ? { ...q, asked: data.asked ?? q.asked, fits: data.fits, short: data.short ?? q.short, requestId: requestIdFor() } : q))
        setChanged(data.error)
      } else {
        setError(data.error || 'Failed to book')
      }
    } catch {
      setError('Network error. Please try again; it won’t book twice.')
    } finally {
      setBooking(false)
    }
  }, [quote, booking, brand, notes])

  const inputClass = 'border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent w-full'
  const labelClass = 'text-xs font-medium text-gray-600 mb-1'
  const btn = (active: boolean) => `px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${active ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`
  const today = centralDate(new Date())

  return (
    <>
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-5 sm:px-6 sm:py-6 max-h-[60vh] overflow-y-auto">
        <fieldset disabled={busy} className="max-w-3xl mx-auto min-w-0 border-0 p-0 m-0">
          <h2 className="text-base sm:text-lg font-bold text-gray-900">Get a quote for several markets</h2>
          <p className="text-xs sm:text-sm text-gray-500 mt-0.5 mb-4">One booking across up to {MAX_MARKETS} markets, each with its own dates and trucks.</p>

          <div className="space-y-3">
            {rows.map((r, i) => {
              const err = rowErrors.find(e => e.rowId === r.id)
              const days = calDays(r)
              return (
                <div key={r.id} className="border border-gray-200 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-gray-500">Market {i + 1}</span>
                    {rows.length > 1 && <button type="button" onClick={() => removeRow(r.id)} className="text-xs text-gray-400 hover:text-red-600">Remove</button>}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="col-span-2 sm:col-span-1">
                      <label className={labelClass}>Market</label>
                      <MarketInput value={r.market} onChange={v => updateRow(r.id, { market: v })} className={inputClass} ariaLabel={`Market ${i + 1}`} />
                    </div>
                    <div>
                      <label className={labelClass}>Start date</label>
                      <input type="date" value={r.startDate} min={today} onChange={e => updateRow(r.id, { startDate: e.target.value })} className={inputClass} />
                    </div>
                    <div>
                      <label className={labelClass}>End date</label>
                      <input type="date" value={r.endDate} min={r.startDate || today} onChange={e => updateRow(r.id, { endDate: e.target.value })} className={inputClass} />
                    </div>
                    <div>
                      <label className={labelClass}>Trucks</label>
                      <input type="number" min={1} max={20} placeholder="1" value={r.trucks ?? ''}
                        onChange={e => updateRow(r.id, { trucks: e.target.value ? parseInt(e.target.value, 10) : undefined })} className={inputClass} />
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    {days > 6 ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-gray-600">Schedule:</span>
                        {([5, 6, 7] as const).map(d => <button key={d} type="button" className={btn(r.daysPerWeek === d)} onClick={() => updateRow(r.id, { daysPerWeek: d })}>{schedule(d)}</button>)}
                      </div>
                    ) : days > 0 ? <span className="text-xs text-gray-500">Runs every day: {days} day{days === 1 ? '' : 's'}</span> : null}
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-600">Hours:</span>
                      {([8, 10, 12] as const).map(h => <button key={h} type="button" className={btn(r.hours === h)} onClick={() => updateRow(r.id, { hours: h })}>{h} hr</button>)}
                    </div>
                  </div>
                  {err && (
                    <div className="mt-2 text-xs text-red-700">
                      {err.message}
                      {err.candidates && (
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {err.candidates.map(c => <button key={c} type="button" onClick={() => pickCandidate(r.id, c)} className="px-2 py-1 bg-white border border-amber-300 rounded text-amber-900 hover:bg-amber-50">{c}</button>)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {rows.length < MAX_MARKETS && (
            <button type="button" onClick={() => { setRows(rs => [...rs, blankRow()]); clear() }} className="mt-3 text-sm font-medium text-green-700 hover:text-green-800">+ Add a market</button>
          )}

          <div className="mt-3 grid sm:grid-cols-2 gap-3">
            <BrandInput value={brand} onChange={setBrand} className={inputClass} label="Brand (optional)" hint="The brand this campaign is for." />
            <div>
              <label className={labelClass}>Notes (optional)</label>
              <input value={notes} onChange={e => setNotes(e.target.value)} maxLength={1000} className={inputClass} placeholder="Anything the team should know" />
            </div>
          </div>

          <button onClick={() => getQuote()} disabled={loading || !complete}
            title={!complete ? 'Fill in every market, its dates and trucks' : undefined}
            className="mt-4 w-full sm:w-auto bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-xl px-6 py-2.5 text-sm font-semibold transition-colors">
            {loading ? 'Checking…' : 'Get Quote'}
          </button>
        </fieldset>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-6 sm:px-6 max-w-3xl mx-auto space-y-4">
          {loading && <p className="text-sm text-gray-500 text-center py-8">Checking availability and pricing across your markets…</p>}
          {error && <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800">{error}</div>}
          {/* Outside the quote card: a placed booking is always shown. */}
          {booked && <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800 font-medium">{'✓'} {booked}</div>}

          {quote && !loading && (
            <>
              {quote.short && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
                  <p className="font-medium">Not every truck can be covered for these dates.</p>
                  <ul className="mt-1 text-xs list-disc pl-4">
                    {quote.asked.lines.filter(l => l.missing > 0).map(l => (
                      <li key={l.id}>{l.market}: {l.missing} of {l.trucks} truck{l.trucks === 1 ? '' : 's'} can&apos;t be covered</li>
                    ))}
                  </ul>
                  {quote.fits && <p className="mt-2 text-xs">Below is what we can book now, priced on what it is: a market with fewer trucks is priced for those trucks.</p>}
                </div>
              )}

              {quote.fits && <Customize view={quote.fits} features={features} onChange={setFeature} disabled={busy} />}
              {quote.fits ? (
                <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900">{quote.short ? 'What we can book now' : 'Your quote'}</h3>
                    <span className="text-lg font-bold text-gray-900">{money(quote.fits.total)}</span>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {quote.fits.lines.map(l => (
                      <div key={l.id} className="px-4 py-3 text-sm flex items-start justify-between gap-3">
                        <div>
                          <p className="font-medium text-gray-900">{l.market}</p>
                          <p className="text-xs text-gray-500">
                            {l.trucks} truck{l.trucks === 1 ? '' : 's'} · {schedule(l.daysPerWeek)} · {l.hours} hr · {l.firstDay && l.lastDay ? `${fmt(l.firstDay)} – ${fmt(l.lastDay)}` : `${fmt(l.startDate)} – ${fmt(l.endDate)}`}
                          </p>
                          <p className="text-xs text-gray-500">{l.truckDays} truck-days · media {money(l.media - l.studiesTotal)}{l.studiesTotal > 0 ? ` · lift studies ${money(l.studiesTotal)} (whole order)` : ''}{l.transport > 0 ? ` · transport ${money(l.transport)}` : ''}</p>
                          {l.truckDays < l.requestedTruckDays && (
                            <p className="text-xs text-amber-700">{l.requestedTruckDays - l.truckDays} fewer truck-days than asked: a truck shares its week with another market. You pay for the days worked.</p>
                          )}
                        </div>
                        <span className="font-semibold text-gray-900 whitespace-nowrap">{money(l.total)}</span>
                      </div>
                    ))}
                  </div>
                  <Breakdown view={quote.fits} features={quote.features} />
                  <div className="px-4 py-3 border-t border-gray-100">
                    {changed && <p className="text-xs text-amber-800 mb-2">{changed}</p>}
                    {booked ? null : (
                      <button onClick={book} disabled={booking}
                        className="w-full sm:w-auto bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-xl px-6 py-2.5 text-sm font-semibold transition-colors">
                        {booking ? 'Booking…' : quote.short ? `Book what fits (${money(quote.fits.total)})` : `Book (${money(quote.fits.total)})`}
                      </button>
                    )}
                    <p className="text-xs text-gray-400 mt-2">Holds expire in 72 hours, or sooner when a market starts soon.</p>
                  </div>
                </div>
              ) : (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
                  None of these markets can be booked for these dates right now. Ask a question below and the Lime Media team will work on a solution.
                </div>
              )}
            </>
          )}

          {!quote && !loading && !error && !booked && (
            <div className="text-center py-12 text-gray-400">
              <p className="text-lg mb-1">Add your markets above to get started.</p>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

const sum = (lines: Line[], f: (l: Line) => number) => lines.reduce((n, l) => n + f(l), 0)

/**
 * The options and lift studies, priced, as the one-market quote shows them
 * (app/client/ai/page.tsx). Each option's price is what it adds across every
 * market; a study covers the whole order. A change prices the order again.
 */
function Customize({ view, features, onChange, disabled }: { view: View; features: Features; onChange: (p: Partial<Features>) => void; disabled: boolean }) {
  const lines = view.lines
  const st = view.studies
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">Customize features</h3>
      <FeatureToggle label="Shadow Fencing" description="Geo-targeted digital ads in every market"
        cost={sum(lines, l => l.optionPrices.shadowFencing)} checked={features.shadowFencing} onChange={v => onChange({ shadowFencing: v })} disabled={disabled} />
      <FeatureToggle label="Smart Directional" description="GPS-triggered directional messaging"
        cost={sum(lines, l => l.optionPrices.smartDirectional)} checked={features.smartDirectional} onChange={v => onChange({ smartDirectional: v })} disabled={disabled} />
      <FeatureToggle label="Device ID Passback" description="Audience device data for retargeting"
        cost={sum(lines, l => l.optionPrices.deviceId)} checked={features.deviceId} onChange={v => onChange({ deviceId: v })} disabled={disabled} />
      <div className="pt-2 border-t border-gray-100">
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className="text-sm font-medium text-gray-900">Lift Studies</p>
            <p className="text-xs text-gray-500">One study covers the whole campaign{st.uniqueMarkets > 1 ? ` (${st.uniqueMarkets} markets)` : ''}; sales lift is quoted by our team</p>
          </div>
          {!st.reachOk && (
            <span className="text-[10px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">Requires {st.reachMinimum.toLocaleString('en-US')}+ impressions</span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {STUDY_CHOICES.map(study => {
            const on = features.studies.includes(study)
            const unpriced = on && !st.selected.includes(study)
            return (
              // A ticked study can always be unticked, even when the order falls short of the reach minimum.
              <button key={study} type="button" disabled={disabled || (!st.reachOk && !on)}
                onClick={() => onChange({ studies: on ? features.studies.filter(s => s !== study) : [...features.studies, study] })}
                className={`text-left text-xs rounded-lg border px-3 py-2 transition-all ${on ? 'border-purple-300 bg-purple-50 text-purple-800 font-medium' : st.reachOk ? 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50' : 'border-gray-100 bg-gray-50 text-gray-400 cursor-not-allowed'}`}>
                <span className="mr-1.5">{on ? '\u2713' : '\u25CB'}</span>
                {STUDY_LABELS[study]}
                <span className="block text-[10px] text-gray-500 font-normal">{unpriced ? 'Not included: reach is under the minimum' : study === 'sales_lift' ? 'Our team will quote it' : money(st.prices[study] ?? 0)}</span>
              </button>
            )
          })}
        </div>
        {st.warning && <p className="mt-2 text-xs text-amber-700">{st.warning}</p>}
      </div>
    </div>
  )
}

/**
 * The order's price as the one-market quote lists it: base media, each option
 * chosen, each study, transport and the total. Base media is the media less
 * the options and studies, so the lines add up to the total exactly.
 */
function Breakdown({ view, features }: { view: View; features: Features }) {
  const lines = view.lines
  const st = view.studies
  const sf = features.shadowFencing ? sum(lines, l => l.shadowFencing) : 0
  const sd = features.smartDirectional ? sum(lines, l => l.smartDirectional) : 0
  const did = features.deviceId ? sum(lines, l => l.deviceId) : 0
  const transport = sum(lines, l => l.transport)
  const base = sum(lines, l => l.media) - sf - sd - did - st.total
  const priced = st.selected.filter(s => s !== 'sales_lift')
  const row = (label: string, amount: number, plus = true) => (
    <div key={label} className="flex justify-between text-gray-600"><span>{label}</span><span>{plus ? '+ ' : ''}{money(amount)}</span></div>
  )
  return (
    <div className="px-4 py-3 border-t border-gray-100 space-y-1.5 text-sm">
      {row(`Base media (${sum(lines, l => l.truckDays)} truck-days)`, base, false)}
      {sf > 0 && row('Shadow fencing', sf)}
      {sd > 0 && row('Smart Directional', sd)}
      {did > 0 && row('Device ID Passback', did)}
      {priced.map(s => row(`${STUDY_LABELS[s]} study`, st.prices[s] ?? 0))}
      {st.salesLiftRequested && <div className="flex justify-between text-gray-500 text-xs"><span>Sales lift: our team will quote it</span><span>not included</span></div>}
      {transport > 0 && row('Transport', transport)}
      <div className="flex justify-between font-bold text-gray-900 pt-2 border-t border-gray-200 text-base"><span>Total</span><span>{money(view.total)}</span></div>
    </div>
  )
}

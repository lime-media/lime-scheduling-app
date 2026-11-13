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

import { MarketInput } from '@/components/MarketInput'
import { SHORT_RANGE_MAX_DAYS } from '@/lib/pricing/schedule'
import { DEFAULT_STAGE, OPEN_STAGES, type OpenStage } from '@/lib/sfdcStages'
import { DEFAULT_BRAND_MARKUP_PCT, MAX_BRAND_MARKUP_PCT, chosenClientType, clampBrandMarkup, type ClientType } from '@/lib/pricing/brandMarkup'
import { Fragment, useEffect, useRef, useState } from 'react'
import { copyDatesDown, holdStartDates } from '@/lib/planner/rows'
import { ClientTypePicker, LeadSourcePicker, OpportunityNameInput, OpportunityTypePicker } from '@/components/OpportunityFields'
import { planOpportunityName } from '@/lib/opportunityName'
import { savedBrand } from '@/lib/brand'
import { AccountSearch, type SfdcAccount } from '@/components/AccountSearch'
import { ContactSearch, type SfdcContact } from '@/components/ContactSearch'
import { HoldLength, HoldUntil, DEFAULT_HOLD_DAYS } from '@/components/HoldLength'
import { centralDate } from '@/lib/dateOnly'
import { STAFF_MIN_DAYS_BEFORE_START, reviseHoldExpiry } from '@/lib/holdExpiry'
import { OpportunityPicker, type OpenOpportunity } from '@/components/OpportunityPicker'
import { BrandInput } from '@/components/BrandInput'
import { SalesforceFailureModal } from '@/components/SalesforceFailureModal'
import { useReopenConfirm } from '@/components/ReopenOpportunityDialog'
import type { Area, AreaBuildResult, AreaFlag, ZipRow } from '@/lib/planning/areas'
import type { ReviewFinding } from '@/lib/planning/claude'
import type { Arrival, LineQuote, MultiMarketQuote, QuoteRow, RowError } from '@/lib/planning/quote'
import { selectionTotal } from '@/lib/planning/studies'
import { STUDY_MIN_IMPRESSIONS, STUDY_PRICE, VALID_STUDIES, type StudyType } from '@/lib/pricing/config'
import { BRAND_LIFT_PRICE, STUDY_EXTRA_MARKET_PRICE, STUDY_INCLUDED_MARKETS } from '@/lib/pricing/studies'

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
const STUDY_LABELS: Record<StudyType, string> = { web_lift: 'Web lift', foot_traffic: 'Foot traffic', brand_lift: 'Brand lift', sales_lift: 'Sales lift' }
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

/** Like the single-market quote: a range of 6 days or fewer is priced Mon-Fri; longer ranges pick a schedule. */
function ScheduleSelect({ start, end, value, onChange, fill }: { start: string; end: string; value: number; onChange: (v: number) => void; fill?: boolean }) {
  const cal = calendarDays(start, end)
  if (cal > 0 && cal <= SHORT_RANGE_MAX_DAYS) return <div className="text-xs text-gray-500 px-1 py-2 whitespace-nowrap" title="A range of 6 days or fewer runs, and is billed, every day">Every day ({cal} day{cal === 1 ? '' : 's'})</div>
  return (
    // `fill`: takes its grid cell's width (the markets list); otherwise wide enough for its longest option.
    <select className={input + (fill ? '' : ' min-w-[12rem]')} value={value} onChange={e => onChange(Number(e.target.value))}>
      {SCHEDULE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

/** One id per booking attempt; retries reuse it, a new attempt gets a new one. */
const newBookingId = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '')

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
// A quote line's first row: its trucks follow on a second row, so no bottom border here.
const tdTop = 'px-2 pt-1.5 pb-0.5 text-sm text-gray-800 align-top'
const tdTopNum = tdTop + ' text-right tabular-nums'
// An unselected market greys out: on the cells themselves, since each cell sets its own text colour.
const unselectedRow = '[&>td]:text-gray-400'
// The markets list: one line per market from lg up, a two-column card per market below.
const marketGridCols = 'lg:grid-cols-[minmax(10rem,1.3fr)_minmax(17rem,2fr)_4.5rem_minmax(12rem,1.2fr)_5.5rem_1.5rem]'
const marketGrid = 'gap-x-2 ' + marketGridCols
const gridTh = 'text-left text-xs font-medium text-gray-500 py-1.5 whitespace-nowrap'
const cell = 'lg:py-1.5 text-sm text-gray-800'
const cellLabel = 'block lg:hidden text-xs font-medium text-gray-500 mb-0.5'

/** A booking being revised (Reservations → Revise; /api/bookings/revise). */
type Revision = {
  key: string; opportunityName: string | null; clientName: string; live: boolean
  /** The latest expiry of its live holds (ISO), which a revision won't cut back; how many markets are committed. */
  heldUntil: string | null; committedMarkets: string[]
  /** What it holds now: the trucks and markets a quote-only revision releases. */
  heldTrucks: number; heldMarkets: number
  /** Its opportunity is Closed Lost and the person agreed to move it back to WARM when the revision is saved. */
  reopenOpportunity: boolean
}

export function PlannerTab({ reviseKey = null, reserve = false, onReviseDone }: {
  reviseKey?: string | null
  /** Opened from Reservations → Quotes → Reserve: a quote-only log opens to reserve its trucks. */
  reserve?: boolean
  onReviseDone?: () => void
} = {}) {
  const [account, setAccount] = useState<SfdcAccount | null>(null)
  const [revision, setRevision] = useState<Revision | null>(null)
  const [reviseError, setReviseError] = useState<string | null>(null)
  // A Closed Lost opportunity: asked before it is moved back to WARM.
  const reopen = useReopenConfirm()
  // An existing opportunity to add this order to; null = a new one. (A
  // revision always goes onto its own booking's opportunity.)
  const [attachTo, setAttachTo] = useState<OpenOpportunity | null>(null)
  // The opportunity's primary contact: required by sales ops on every opportunity.
  const [contact, setContact] = useState<SfdcContact | null>(null)
  // How long the reservations hold the trucks (default 3 days).
  const [holdDays, setHoldDays] = useState(DEFAULT_HOLD_DAYS)
  // A live booking's revision: the date it's held until (YYYY-MM-DD, Central), opened on its current expiry.
  const [holdUntil, setHoldUntil] = useState<string | null>(null)
  // The campaign's brand, for the Salesforce opportunity (components/BrandInput.tsx).
  const [brand, setBrand] = useState('')
  const [rows, setRows] = useState<QuoteRow[]>([newRow()])
  const [rowErrors, setRowErrors] = useState<RowError[]>([])
  const [features, setFeatures] = useState<{ shadowFencing: boolean; smartDirectional: boolean; deviceId: boolean; studies: StudyType[] }>({ shadowFencing: true, smartDirectional: false, deviceId: false, studies: [] })
  // Brand Direct accounts: a premium folded into every price (internal control only).
  const [brandMarkupPct, setBrandMarkupPct] = useState<number>(DEFAULT_BRAND_MARKUP_PCT)
  // The opportunity's Client Type and Lead Source: the seller picks both,
  // starting from the account's (components/OpportunityFields.tsx).
  const [clientType, setClientType] = useState<ClientType>('Agency')
  const [leadSource, setLeadSource] = useState('')
  const [opportunityType, setOpportunityType] = useState('')
  // The seller's own name for a new opportunity; null = the generated one (lib/opportunityName.ts).
  const [oppName, setOppName] = useState<string | null>(null)
  const isBrandDirect = clientType === 'Brand Direct'
  // A revised booking that loaded without an account: the client type it was
  // priced as, applied when the seller picks its account.
  const revisedClientType = useRef<ClientType | null>(null)
  // Booked onto an opportunity that already exists (a revision's own, or one
  // picked to add to), which keeps its lead source; otherwise one is made.
  const keepsOpportunity = revision ? !!revision.opportunityName : !!attachTo
  // Opportunity stage for the order's opportunity: Cold, Warm or Hot (never closed).
  const [stage, setStage] = useState<OpenStage>(DEFAULT_STAGE)
  // Low conviction: log a priced opportunity without reserving any truck.
  const [quoteOnly, setQuoteOnly] = useState(false)
  // Switching between "log quote only" and a real booking is a different
  // booking attempt: new id, and any earlier result no longer applies. (The
  // server also keeps the two in separate id spaces.)
  useEffect(() => { bookingId.current = newBookingId(); setHoldResult(null) }, [quoteOnly])

  // Open a booking for revision: its account, contact, brand, markets and
  // options, ready to change and re-quote.
  useEffect(() => {
    if (!reviseKey) return
    let alive = true
    setReviseError(null)
    let reopenAgreed = false
    const load = async (agreed: boolean): Promise<{ [k: string]: any }> => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const r = await fetch(`/api/bookings/revise?key=${encodeURIComponent(reviseKey)}${agreed ? '&reopen=1' : ''}`)
      const d = await r.json()
      // A Closed Lost opportunity: ask, then load it to be reopened on save.
      if (r.status === 409 && d.reopenable && !agreed && alive && await reopen.ask(d.reopenable.question)) {
        reopenAgreed = true
        return load(true)
      }
      if (!r.ok) throw new Error(d.error || 'That booking could not be opened.')
      return d.booking
    }
    load(false)
      .then(b => {
        if (!alive) return
        // Priced as it was booked: the client type its holds record; on older
        // holds, a recorded Brand Direct markup means Brand Direct; else the account's.
        // A booking with no opportunity loads without an account: the type
        // waits for the account the seller picks (AccountSearch below).
        const booked = chosenClientType(b.clientType) ?? (typeof b.brandMarkupPct === 'number' && b.brandMarkupPct > 0 ? 'Brand Direct' : null)
        revisedClientType.current = b.account ? null : booked
        if (b.account) {
          setAccount(b.account)
          setClientType(booked ?? b.account.clientType ?? 'Agency')
        }
        // A lead source is asked for only if a new opportunity is made; never
        // carry over one picked for an earlier quote's account.
        setLeadSource('')
        setOpportunityType('')
        setOppName(null)
        setContact(b.contact)
        setBrand(b.brand ?? '')
        setRows(b.rows.map((r: { market: string; startDate: string; endDate: string; trucks: number; daysPerWeek: number; hours: number }) =>
          newRow({ market: r.market, startDate: r.startDate, endDate: r.endDate, trucks: r.trucks, daysPerWeek: r.daysPerWeek, hours: r.hours })))
        // The booking's lift studies come back with it (lib/bookings.ts reviseRows).
        setFeatures({ ...b.features, studies: Array.isArray(b.features?.studies) ? b.features.studies : [] })
        // Reopen in the mode it was logged in: a quote-only log reserved nothing,
        // so revising it must not reserve trucks unless the rep unticks it, or
        // opened it with Reserve (Reservations → Quotes).
        setQuoteOnly(b.quoteOnly === true && !reserve)
        if (typeof b.brandMarkupPct === 'number') { revisedMarkup.current = b.brandMarkupPct; setBrandMarkupPct(b.brandMarkupPct) }
        setAttachTo(null)
        // What it holds now (live holds only), for the quote-only release warning.
        const held = { trucks: Number(b.held?.trucks) || 0, markets: Number(b.held?.markets) || 0 }
        setRevision({ key: b.key, opportunityName: b.opportunityName, clientName: b.clientName, live: b.live, heldUntil: b.heldUntil ?? null, committedMarkets: Array.isArray(b.committedMarkets) ? b.committedMarkets : [], reopenOpportunity: reopenAgreed, heldTrucks: held.trucks, heldMarkets: held.markets })
        setHoldUntil(b.live && b.heldUntil ? centralDate(new Date(b.heldUntil)) : null)
      })
      .catch(e => { if (alive) setReviseError(e instanceof Error ? e.message : 'That booking could not be opened.') })
    return () => { alive = false }
  }, [reviseKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const stopRevising = () => { setRevision(null); setHoldUntil(null); onReviseDone?.() }

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
  const [holdResult, setHoldResult] = useState<HoldResult | null>(null)
  // Salesforce failed after the booking saved: a red pop-up until dismissed.
  const [sfdcFailureOpen, setSfdcFailureOpen] = useState(false)
  // Markets to book. Every market with a truck is selected when a quote arrives.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // One id per quote shown. Every booking attempt for this quote reuses it, so
  // a retry after a timeout returns the first attempt's holds, never a second set.
  const bookingId = useRef('')
  const showQuote = (q: MultiMarketQuote) => {
    setQuote(q)
    setSelected(new Set(q.lines.filter(l => l.missing < l.trucks).map(l => l.id)))
    bookingId.current = newBookingId()
  }

  // A quote is only good for the inputs it was built from. Any change to the
  // markets, options or client clears it, so the button can never book
  // something other than what is on screen.
  useEffect(() => {
    setQuote(null); setHoldResult(null)
  }, [rows, features, account, brandMarkupPct])
  // A new client starts at the default markup.
  // A new account starts at the default markup; a revised booking at the one it was sold at.
  const revisedMarkup = useRef<number | null>(null)
  useEffect(() => { setBrandMarkupPct(revisedMarkup.current ?? DEFAULT_BRAND_MARKUP_PCT); revisedMarkup.current = null }, [account?.id])

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
    clientType: account ? clientType : undefined,
    brandMarkupPct: isBrandDirect ? clampBrandMarkup(brandMarkupPct) : undefined,
    // Revising: the server frees the booking's trucks and keeps them where they fit.
    revise: revision ? { bookingKey: revision.key } : undefined,
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

  const placeHolds = async (allowPartial = false, expectedTotal?: number, reopenAgreed = revision?.reopenOpportunity === true): Promise<void> => {
    if (!account || !contact || !quote) return
    const shown = expectedTotal ?? selectionTotal(quote.lines, selected, quote.studies, quote.brandMarkupPct).total
    setHolding(true); setHoldResult(null)
    try {
      const res = await fetch('/api/plan/hold', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...requestBody(), selectedIds: [...selected], allowPartial, requestId: bookingId.current, expectedTotal: shown, stage, leadSource: keepsOpportunity ? undefined : leadSource, opportunityType: keepsOpportunity ? undefined : opportunityType, opportunityName: keepsOpportunity || !oppName?.trim() ? undefined : oppName, quoteOnly, brand, primaryContactId: contact.id, primaryContactName: contact.name, holdDays, holdUntil: revision && holdUntil && !quoteOnly ? holdUntil : undefined, holdUntilFrom: revision && holdUntil && !quoteOnly ? revision.heldUntil ?? undefined : undefined, attachOpportunityId: revision ? undefined : attachTo?.id, reopenOpportunity: revision ? reopenAgreed : undefined }),
      })
      const data = await readJson(res)
      // The opportunity went Closed Lost after the booking was opened: ask now.
      if (res.status === 409 && data.reopenable && revision && !reopenAgreed) {
        setHolding(false)
        if (await reopen.ask(data.reopenable.question)) return placeHolds(allowPartial, expectedTotal, true)
        setHoldResult({ ok: false, message: data.error || 'No holds placed.' })
        return
      }
      if (res.status === 409 && data.shortfalls) {
        const ok = window.confirm(`${data.error}\n\n${data.shortfalls.map((s: { market: string; missing: number }) => `${s.market}: ${s.missing} truck(s) short`).join('\n')}\n\nBook what can be covered? The rest will be noted on the Salesforce opportunity as quoted but not available, and left out of its amount.`)
        if (ok) { setHolding(false); return placeHolds(true, undefined, reopenAgreed) }
        setHoldResult({ ok: false, message: 'No holds placed.' })
        return
      }
      if (res.status === 409 && data.priceChanged) {
        const ok = window.confirm(`Booking ${allowPartial ? 'what can be covered' : 'the selected markets'} on fresh truck data comes to ${fmtMoney(data.priceChanged.now)}, not ${fmtMoney(data.priceChanged.was)}.\n\nBook at ${fmtMoney(data.priceChanged.now)}?`)
        if (ok) { setHolding(false); return placeHolds(allowPartial, data.priceChanged.now, reopenAgreed) }
        setHoldResult({ ok: false, message: 'No holds placed.' })
        return
      }
      // The revised booking's opportunity is gone from Salesforce since it was
      // opened, so a new one is made: show the lead source picker.
      if (res.status === 400 && data.needLeadSource && revision) setRevision(r => r && { ...r, opportunityName: null })
      if (!res.ok) throw new Error(data.error || 'Holds could not be placed')
      setHoldResult({ ok: true, message: data.confirmation ?? data.message, sfdcFailure: data.sfdcFailure ?? null })
      setSfdcFailureOpen(Boolean(data.sfdcFailure))
      // A finished revision: the booking now stands as booked; leave revise mode.
      if (revision) { setRevision(null); setHoldUntil(null); onReviseDone?.() }
    } catch (e) {
      setHoldResult({ ok: false, message: e instanceof Error ? e.message : 'Holds could not be placed' })
    } finally {
      setHolding(false)
    }
  }

  // Revised as quote only, a live booking gives up its trucks and leaves
  // Reservations: asked once, before anything is sent.
  const releaseAgreed = () => !revision || !quoteOnly || revision.heldTrucks === 0 || window.confirm(
    `Quote only reserves nothing: this releases the ${revision.heldTrucks} truck${revision.heldTrucks === 1 ? '' : 's'} the booking holds in ${revision.heldMarkets} market${revision.heldMarkets === 1 ? '' : 's'}, and the booking leaves Reservations. The quote is logged to Salesforce.\n\nRelease the trucks and log the quote?`,
  )

  const errorFor = (id: string) => rowErrors.find(e => e.rowId === id)
  const ready = rows.length > 0 && rows.every(r => r.market.trim() && r.startDate && r.endDate && r.trucks >= 1)

  return (
    <div>
      {/* Revising an existing booking (Reservations → Revise) */}
      {reviseError && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800 flex items-start justify-between gap-3">
          <span>{reviseError}</span>
          <button onClick={() => { setReviseError(null); onReviseDone?.() }} className="text-xs font-medium underline flex-shrink-0">Start a new quote</button>
        </div>
      )}
      {revision && (
        <div className="mb-4 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-900">
          <div className="flex items-start justify-between gap-3">
            <p className="font-semibold">
              Revising {revision.clientName}&apos;s booking{revision.opportunityName ? <> · <span className="font-normal">{revision.opportunityName}</span></> : null}
            </p>
            <button onClick={stopRevising} className="text-xs font-medium text-blue-700 hover:text-blue-900 underline flex-shrink-0">Cancel revision</button>
          </div>
          <p className="text-xs text-blue-800 mt-1">
            Add, drop or change markets and dates, then quote. Booking replaces this booking&apos;s reservations and updates the same Salesforce opportunity
            {revision.opportunityName ? '' : ' (it has none, so one is created)'}.{' '}
            {revision.live
              ? 'Markets that stay keep their current trucks where those can still do the dates.'
              : 'It has expired, so trucks are picked and priced fresh.'}
            {revision.live && revision.heldUntil && ` Its holds run to ${new Date(revision.heldUntil).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' })}${quoteOnly ? '.' : '; the revision keeps that expiry unless you change the date below.'}`}
            {revision.committedMarkets.length > 0 && ` ${revision.committedMarkets.length} market${revision.committedMarkets.length === 1 ? ' is' : 's are'} committed and stay${revision.committedMarkets.length === 1 ? 's' : ''} committed.`}
          </p>
        </div>
      )}

      {/* 1. Client */}
      <div className={card}>
        <h2 className="text-sm font-semibold text-gray-900 mb-2">1. Select Client (Salesforce Account)</h2>
        <AccountSearch suggestType selected={account} onSelect={a => {
          // A booking is revised on its own account; another account is a new quote.
          // A booking that loaded without one (no Salesforce opportunity) needs
          // its account picked, and that keeps the revision.
          const changingClient = !!revision && !!account
          if (changingClient && !window.confirm('Changing the client stops revising this booking and starts a new quote. Continue?')) return
          if (changingClient) stopRevising()
          setAccount(a); setClientType((revision && !account ? revisedClientType.current : null) ?? a?.clientType ?? 'Agency'); setLeadSource(a?.leadSource ?? ''); setOpportunityType(a?.opportunityType ?? ''); setOppName(null); setContact(null); setAttachTo(null); setQuote(null); setHoldResult(null)
        }} />
        {account && (
          <div className="mt-3">
            {/* Sets Brand Direct pricing, so a change needs a fresh price. */}
            <div className="mb-3">
              <ClientTypePicker value={clientType} onChange={t => { if (t !== clientType) { setClientType(t); setQuote(null); setHoldResult(null) } }} />
            </div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Primary contact <span className="text-red-500">*</span></label>
            <ContactSearch accountId={account.id} selected={contact} onSelect={setContact} />
            {!revision && (
              <div className="mt-3">
                <OpportunityPicker accountId={account.id} value={attachTo} onChange={o => {
                  // Adding to an opportunity starts at its own Client Type (it was priced that way); a new one at the account's.
                  setAttachTo(o)
                  const t = o?.clientType ?? account.clientType ?? 'Agency'
                  if (t !== clientType) { setClientType(t); setQuote(null); setHoldResult(null) }
                }} />
              </div>
            )}
          </div>
        )}
        <div className="mt-3 max-w-sm">
          <BrandInput value={brand} onChange={setBrand} className={input} />
        </div>
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

        {/* A grid, not a table, so it fits the card: one line per market on a
            laptop, a stacked card per market below lg. No sideways scrolling. */}
        <div>
          <div className={'hidden lg:grid border-b border-gray-200 ' + marketGrid}>
            <div className={gridTh}>Market</div><div className={gridTh}>Start / End</div>
            <div className={gridTh}>Trucks</div><div className={gridTh}>Schedule</div><div className={gridTh}>Hours</div><div />
          </div>
          <div>
              {rows.map((r, i) => {
                const err = errorFor(r.id)
                return (
                  <div key={r.id} className={'grid grid-cols-2 gap-x-2 gap-y-1 py-2 border-b border-gray-100 lg:gap-y-0 lg:py-0 ' + marketGridCols}>
                    <div className={cell + ' col-span-2 lg:col-span-1 min-w-0'}>
                      <span className={cellLabel}>Market</span>
                      <MarketInput className={input} value={r.market} ariaLabel="Market"
                        onChange={v => updateRow(r.id, { market: v, lat: undefined, lng: undefined })} />
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
                    </div>
                    <div className={cell + ' col-span-2 lg:col-span-1 min-w-0'}>
                      <span className={cellLabel}>Start / End</span>
                      <div className="flex gap-2">
                        <input type="date" className={input} aria-label="Start" min={todayStr()} value={r.startDate} onChange={e => updateRow(r.id, { startDate: e.target.value })} />
                        <input type="date" className={input} aria-label="End" min={r.startDate || todayStr()} value={r.endDate} onChange={e => updateRow(r.id, { endDate: e.target.value })} />
                      </div>
                      {/* Same flight for the markets below: copy this row's dates down. Sits under the
                          dates (not off to the right) so it's in view; only rows below change. */}
                      {i < rows.length - 1 && (
                        <button onClick={() => setRows(rs => copyDatesDown(rs, r.id))}
                          disabled={!r.startDate || !r.endDate}
                          className="mt-1 text-xs font-medium text-green-700 hover:text-green-800 disabled:text-gray-400 disabled:cursor-not-allowed"
                          title={r.startDate && r.endDate ? `Set every market below to ${r.startDate} – ${r.endDate}` : "Set this row's start and end first"}>
                          ↓ Copy dates to markets below
                        </button>
                      )}
                    </div>
                    <div className={cell}>
                      <span className={cellLabel}>Trucks</span>
                      <input type="number" min={1} max={50} className={input} aria-label="Trucks" value={r.trucks} onChange={e => updateRow(r.id, { trucks: Math.max(1, parseInt(e.target.value) || 1) })} />
                    </div>
                    <div className={cell + ' min-w-0'}>
                      <span className={cellLabel}>Schedule</span>
                      <ScheduleSelect fill start={r.startDate} end={r.endDate} value={r.daysPerWeek} onChange={v => updateRow(r.id, { daysPerWeek: v })} />
                    </div>
                    <div className={cell}>
                      <span className={cellLabel}>Hours</span>
                      <select className={input} aria-label="Hours" value={r.hours} onChange={e => updateRow(r.id, { hours: Number(e.target.value) })}>
                        {[8, 10, 12].map(h => <option key={h} value={h}>{h} hr</option>)}
                      </select>
                    </div>
                    <div className={cell + ' self-end lg:self-auto'}>
                      <button onClick={() => setRows(rs => (rs.length > 1 ? rs.filter(x => x.id !== r.id) : rs))} className="text-gray-400 hover:text-red-600 text-sm" title="Remove" aria-label="Remove market">✕<span className="lg:hidden"> Remove</span></button>
                    </div>
                  </div>
                )
              })}
          </div>
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
        </div>
        {/* Lift studies: one study covers the whole order (lib/pricing/studies.ts). */}
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-gray-700">
          <span className="text-xs font-medium text-gray-600">Lift studies</span>
          {VALID_STUDIES.map(st => (
            <label key={st} className="flex items-center gap-2">
              <input type="checkbox" checked={features.studies.includes(st)}
                onChange={e => setFeatures(f => ({ ...f, studies: e.target.checked ? [...f.studies, st] : f.studies.filter(x => x !== st) }))} />
              {STUDY_LABELS[st]}{st === 'sales_lift' && <span className="text-xs text-gray-500">(the team quotes it)</span>}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-gray-500">One study covers the whole order: {fmtMoney(STUDY_PRICE)} with {STUDY_INCLUDED_MARKETS} markets, +{fmtMoney(STUDY_EXTRA_MARKET_PRICE)} per extra market (a client&apos;s rate card may set its own base); brand lift {fmtMoney(BRAND_LIFT_PRICE)}. Studies need {STUDY_MIN_IMPRESSIONS.toLocaleString('en-US')} estimated impressions across the order.</p>
        {/* A new opportunity's lead source, type and name; a revision or an attach keeps its opportunity's own. */}
        {!keepsOpportunity && (
          <div className="mt-3">
            <LeadSourcePicker value={leadSource} onChange={setLeadSource} />
            <div className="mt-2"><OpportunityTypePicker value={opportunityType} onChange={setOpportunityType} /></div>
            <div className="mt-2 max-w-xl">
              <OpportunityNameInput value={oppName} onChange={setOppName}
                defaultName={planOpportunityName(savedBrand(brand), account?.name || 'Client', quote
                  ? quote.lines.filter(l => selected.has(l.id))
                  : rows.filter(r => r.market.trim() && r.startDate && r.endDate))} />
            </div>
          </div>
        )}
        <div className="mt-3 flex items-center gap-2 text-xs">
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
        <label className="mt-2 flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
          <input type="checkbox" checked={quoteOnly} onChange={e => setQuoteOnly(e.target.checked)} className="mt-0.5 rounded" />
          <span><span className="font-medium">Log quote only, no reservation</span>: creates the priced Salesforce opportunity but reserves no trucks (for low-conviction quotes).</span>
        </label>
        {isBrandDirect && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-purple-200 bg-purple-50 px-3 py-2 text-xs text-purple-900">
            <span className="font-semibold">Brand Direct pricing</span>
            <label className="flex items-center gap-1">
              +
              <input type="number" min={0} max={MAX_BRAND_MARKUP_PCT} step={0.5} value={brandMarkupPct}
                onChange={e => setBrandMarkupPct(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={() => setBrandMarkupPct(clampBrandMarkup(brandMarkupPct))}
                aria-label="Brand Direct markup percent"
                className="w-16 border border-purple-200 rounded px-1.5 py-0.5 text-right text-sm bg-white focus:outline-none focus:ring-2 focus:ring-purple-400" />
              %
            </label>
            <span className="text-purple-700">included in every price, transport too. Not shown to the client.</span>
          </div>
        )}
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
          contact={contact}
          revising={revision !== null}
          needsLeadSource={!keepsOpportunity && !leadSource}
          needsOpportunityType={!keepsOpportunity && !opportunityType}
          committedMarkets={revision?.committedMarkets ?? []}
          attachName={revision ? null : attachTo?.name ?? null}
          holdDays={holdDays}
          onHoldDays={setHoldDays}
          holdUntil={revision?.heldUntil && holdUntil ? { date: holdUntil, heldUntil: revision.heldUntil } : null}
          onHoldUntil={setHoldUntil}
          holding={holding}
          holdResult={holdResult}
          selected={selected}
          onToggle={id => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })}
          onPlaceHolds={() => { if (releaseAgreed()) void placeHolds(false) }}
          quoteOnly={quoteOnly}
          unplaced={built?.unplaced.map(u => u.label) ?? []}
        />
      )}
      {reopen.dialog}
      {holdResult?.sfdcFailure && sfdcFailureOpen && (
        <SalesforceFailureModal detail={holdResult.sfdcFailure} onClose={() => setSfdcFailureOpen(false)} />
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
      <div className="flex flex-wrap gap-2 mb-2 [&>div]:flex-1 [&>div]:min-w-[8rem]">
        <div><label className="text-xs text-gray-600">Start</label><input type="date" className={input} value={bulk.startDate} onChange={e => setBulk({ ...bulk, startDate: e.target.value })} /></div>
        <div><label className="text-xs text-gray-600">End</label><input type="date" className={input} value={bulk.endDate} onChange={e => setBulk({ ...bulk, endDate: e.target.value })} /></div>
        <div><label className="text-xs text-gray-600">Trucks each</label><input type="number" min={1} className={input} value={bulk.trucks} onChange={e => setBulk({ ...bulk, trucks: Math.max(1, parseInt(e.target.value) || 1) })} /></div>
        <div><label className="text-xs text-gray-600">Schedule</label>
          <ScheduleSelect start={bulk.startDate} end={bulk.endDate} value={bulk.daysPerWeek} onChange={v => setBulk({ ...bulk, daysPerWeek: v })} /></div>
        <div><label className="text-xs text-gray-600">Hours</label>
          <select className={input + ' min-w-[5.5rem]'} value={bulk.hours} onChange={e => setBulk({ ...bulk, hours: Number(e.target.value) })}>{[8, 10, 12].map(h => <option key={h} value={h}>{h} hr</option>)}</select></div>
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

/** A booking's outcome; sfdcFailure is set when the holds saved but Salesforce didn't. */
type HoldResult = { ok: boolean; message: string; sfdcFailure?: string | null }

function QuoteResult({ quote, account, contact, revising, needsLeadSource, needsOpportunityType, committedMarkets, attachName, holdDays, onHoldDays, holdUntil, onHoldUntil, holding, holdResult, selected, onToggle, onPlaceHolds, quoteOnly, unplaced }: {
  quote: MultiMarketQuote
  account: SfdcAccount | null
  contact: SfdcContact | null
  /** Booking replaces an existing booking (Reservations → Revise). */
  revising: boolean
  /** A new opportunity with no lead source picked yet: booking waits for one. */
  needsLeadSource: boolean
  needsOpportunityType: boolean
  /** On a revision, the markets (lower-cased) that stay committed: they hold nothing, so they don't cap the expiry. */
  committedMarkets: string[]
  /** Booking is added to this existing opportunity. */
  attachName: string | null
  holdDays: number
  onHoldDays: (days: number) => void
  /** Revising a live booking: its expiry date, shown instead of a hold length. */
  holdUntil: { date: string; heldUntil: string } | null
  onHoldUntil: (date: string) => void
  holding: boolean
  holdResult: HoldResult | null
  selected: Set<string>
  onToggle: (id: string) => void
  onPlaceHolds: () => void
  quoteOnly: boolean
  unplaced: string[]
}) {
  const { summary } = quote
  const [openTruck, setOpenTruck] = useState<string | null>(null)
  const short = quote.lines.filter(l => l.missing > 0)
  const chosen = quote.lines.filter(l => selected.has(l.id))
  // The order's studies priced again for just the selected markets, as the
  // server books them: the panel below and the button both describe that.
  const selection = selectionTotal(quote.lines, selected, quote.studies, quote.brandMarkupPct)
  const chosenTotal = selection.total
  const st = selection.studies
  const chosenLines = quote.lines.filter(l => selected.has(l.id))
  const booked = holdResult?.ok === true
  const outOfMarket = quote.lines.flatMap(l => l.arrivals).filter(a => a.outOfMarket)
  // The trucks this booking would hold: committed markets keep their own expiry.
  const holdStarts = holdStartDates(chosen.filter(l => !committedMarkets.includes(l.market.trim().toLowerCase())))
  // A revision's expiry date the server would refuse (past, or past the limit): HoldUntil says why.
  const holdUntilResult = !quoteOnly && holdUntil !== null && holdStarts.length > 0
    ? reviseHoldExpiry(holdStarts, holdUntil.date, new Date(holdUntil.heldUntil), new Date(), STAFF_MIN_DAYS_BEFORE_START)
    : null
  const holdUntilRefused = holdUntilResult !== null && 'error' in holdUntilResult

  return (
    <>
      <div className={card}>
        <div className="flex items-baseline">
          <h2 className="text-sm font-semibold text-gray-900">Quote</h2>
          <span className="ml-auto text-2xl font-bold text-gray-900 tabular-nums">{fmtMoney(summary.grandTotal)}</span>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          {summary.markets} markets · {summary.trucksUsed} trucks · {summary.drivers} drivers · pricing: {quote.pricingBasis}
          {quote.brandMarkupPct > 0 && <> · <span className="text-purple-700">Brand Direct +{quote.brandMarkupPct}% included</span></>}
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

        {/* Fits the card on a laptop; the scroll is only a fallback on a phone. */}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>Book</th><th className={th}>Market</th><th className={th}>Dates</th><th className={th}>Schedule</th>
                <th className={th + ' text-right'}>Media</th><th className={th + ' text-right'}>Transport</th><th className={th + ' text-right'}>Total</th>
              </tr>
            </thead>
            <tbody>
              {/* Each market's trucks go on a second line under it, full width, so the
                  table fits the card instead of scrolling sideways. */}
              {quote.lines.map(l => (
                <Fragment key={l.id}>
                <tr className={selected.has(l.id) ? '' : unselectedRow}>
                  <td className={tdTop}>
                    <input type="checkbox" checked={selected.has(l.id)} disabled={booked || (!quoteOnly && l.missing >= l.trucks)} onChange={() => onToggle(l.id)}
                      title={l.missing >= l.trucks ? 'No truck can cover this market' : 'Book this market'} />
                  </td>
                  <td className={tdTop}>{l.market}</td>
                  <td className={tdTop + ' whitespace-nowrap'}><DeliveryDates l={l} /></td>
                  <td className={tdTop}><DeliveryDays l={l} /></td>
                  <td className={tdTopNum}>{fmtMoney(l.media - l.studiesTotal)}</td>
                  <td className={tdTopNum}>
                    {l.transport.billed > 0 ? fmtMoney(l.transport.billed) : <span className="text-gray-400">{l.transport.outcome === 'ABSORBED' ? 'included' : '—'}</span>}
                  </td>
                  <td className={tdTopNum + ' font-medium'}>
                    {/* The order's studies are their own row below (priced once for the order). */}
                    {fmtMoney(l.total - l.studiesTotal)}
                    {l.priceKept && <span className="block text-[11px] font-normal text-blue-700" title="Unchanged in this revision: keeps the price already booked">booked price kept</span>}
                  </td>
                </tr>
                <tr className={selected.has(l.id) ? '' : unselectedRow}>
                  <td className={td} />
                  <td className={td + ' text-xs pt-0'} colSpan={6}>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                      {l.arrivals.map(a => <ArrivalLine key={a.truckNumber} a={a} />)}
                      {l.missing > 0 && <div className="text-red-700">{l.missing} not covered</div>}
                    </div>
                  </td>
                </tr>
                </Fragment>
              ))}
              {quote.studies.total > 0 && (
                <tr>
                  <td className={td}></td>
                  <td className={td} colSpan={5}>Lift studies, one for the whole order ({quote.studies.studies.filter(x => x !== 'sales_lift').map(x => STUDY_LABELS[x]).join(', ')})</td>
                  <td className={tdNum}>{fmtMoney(quote.studies.total)}</td>
                </tr>
              )}
              <tr className="font-medium">
                <td className={td} colSpan={4}>Totals</td>
                <td className={tdNum}>{fmtMoney(summary.media)}</td>
                <td className={tdNum}>{summary.transportBilled > 0 ? fmtMoney(summary.transportBilled) : '—'}</td>
                <td className={tdNum + ' font-bold'}>{fmtMoney(summary.grandTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Reach and lift studies for the markets selected to book (lib/planning/studies.ts selectionTotal). */}
        <div className="mt-3 text-xs text-gray-600 space-y-1">
          <p>
            Estimated reach: {fmtNum(st.estimatedImpressions)} impressions across the {chosenLines.length === quote.lines.length ? 'order' : `${chosenLines.length} selected market${chosenLines.length === 1 ? '' : 's'}`}
            {chosenLines.length > 0 && <>{' '}({chosenLines.map(l => `${l.market} ${fmtNum(l.estimatedImpressions)}`).join(' · ')})</>}: truck-days × each market tier&apos;s daily A18+ impressions per truck.
            {' '}{st.reachOk ? `Lift studies are available (${fmtNum(st.reachMinimum)} needed).` : `Lift studies need ${fmtNum(st.reachMinimum)}.`}
          </p>
          {st.requested.length > 0 && (st.reachOk ? (
            <p>
              Lift studies ({st.uniqueMarkets} unique market{st.uniqueMarkets === 1 ? '' : 's'}): {st.studies.filter(x => x !== 'sales_lift').map(x => `${STUDY_LABELS[x]} ${fmtMoney(st.prices[x])}`).join(', ') || 'none priced'}
              {st.total > 0 && <>, {fmtMoney(st.total)} in all, booked with {st.carriedBy}</>}.
              {st.salesLiftRequested && <> Sales lift: the team quotes it; noted on the booking.</>}
            </p>
          ) : (
            <p className="text-amber-700">The selected lift studies aren&apos;t included: the order&apos;s estimated reach is under {fmtNum(st.reachMinimum)}.</p>
          ))}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-3 text-sm">
          <Fact label="From out of market" value={outOfMarket.length ? `${outOfMarket.length} truck${outOfMarket.length === 1 ? '' : 's'} · ${fmtNum(outOfMarket.reduce((n, a) => n + a.miles, 0))} mi` : 'None'} />
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
          <>
            <div className="mt-4 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-800 font-medium">✓ {holdResult.message}</div>
            {holdResult.sfdcFailure && (
              <div className="mt-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
                <span className="font-semibold">Salesforce was not updated.</span> {holdResult.sfdcFailure}
              </div>
            )}
          </>
        ) : (
          <>
            {/* Hold length: a reservation only (a quote-only log holds nothing). */}
            {!quoteOnly && (holdUntil
              ? <HoldUntil date={holdUntil.date} onChange={onHoldUntil} heldUntil={holdUntil.heldUntil} startDates={holdStarts} result={holdUntilResult} />
              : <HoldLength days={holdDays} onChange={onHoldDays} startDates={holdStarts} />
            )}
            <button onClick={onPlaceHolds} disabled={holding || !account || !contact || needsLeadSource || needsOpportunityType || chosen.length === 0 || holdUntilRefused}
              className="mt-4 w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg px-6 py-3 text-sm font-medium">
              {!account ? 'Select a client above to place holds'
                : !contact ? 'Choose the primary contact above'
                : needsLeadSource ? 'Choose the lead source above'
                : needsOpportunityType ? 'Choose the opportunity type above'
                : chosen.length === 0 ? 'Select at least one market to book'
                : holdUntilRefused ? 'Choose a hold expiry date the booking can be held to'
                : holding ? (quoteOnly ? 'Logging the quote…' : 'Re-checking trucks and placing holds…')
                : revising ? `Update booking${quoteOnly ? ' (quote only, no reservation)' : ''} — ${chosen.length} of ${quote.lines.length} markets, ${fmtMoney(chosenTotal)}`
                : quoteOnly ? `Log quote in Salesforce (no reservation)${attachName ? ' on the chosen opportunity' : ''} — ${chosen.length} of ${quote.lines.length} markets, ${fmtMoney(chosenTotal)}`
                : `Place holds & ${attachName ? 'add to the chosen opportunity' : 'create Salesforce opportunity'} — ${chosen.length} of ${quote.lines.length} markets, ${fmtMoney(chosenTotal)}`}
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

/**
 * The dates the market's trucks actually work, with the requested range
 * beneath whenever it differs. Never shows the request as if it were delivered.
 */
function DeliveryDates({ l }: { l: LineQuote }) {
  const d = l.delivery
  if (!d.firstDay || !d.lastDay) return <>{fmtDate(l.startDate)} – {fmtDate(l.endDate)} <span className="block text-[11px] text-red-700">requested; no truck assigned</span></>
  const differs = d.firstDay !== l.startDate || d.lastDay !== l.endDate
  // Amber only when days are actually short; weekends at the ends of a Mon-Fri
  // range move the dates without losing any day.
  const short = d.days < (l.trucks - l.missing) * l.activationDays
  return (
    <>
      {fmtDate(d.firstDay)} – {fmtDate(d.lastDay)}
      {differs && <span className={`block text-[11px] ${short ? 'text-amber-700 font-medium' : 'text-gray-400'}`}>requested {fmtDate(l.startDate)} – {fmtDate(l.endDate)}</span>}
    </>
  )
}

/** The billed days, worked out: full weeks, then the final part-week as it actually falls. */
function DeliveryDays({ l }: { l: LineQuote }) {
  const d = l.delivery
  const pw = d.partialWeek
  const covered = l.trucks - l.missing
  return (
    <>
      {l.trucks} × {scheduleLabel(l.daysPerWeek)} × {l.hours}h
      <span className="block text-[11px] text-gray-500">
        {d.fullWeeks > 0 && <>{d.fullWeeks} wk{d.fullWeeks === 1 ? '' : 's'}: {d.fullWeekDays}</>}
        {pw && <>{d.fullWeeks > 0 ? ' + ' : ''}part-week {fmtDate(pw.start)}{pw.calendarDays > 1 ? `–${fmtDate(pw.end)}` : ''}: <span className={pw.days < covered * Math.min(pw.calendarDays, l.daysPerWeek) ? 'text-amber-700 font-medium' : ''}>{pw.days}</span></>}
        {' = '}{d.days} {covered > 1 ? 'truck-days' : 'days'}
        {l.missing > 0 && <> + {l.missing * l.activationDays} quoted, not covered</>}
      </span>
    </>
  )
}

/** Where one truck comes from, as the single-market quote shows it. */
function ArrivalLine({ a }: { a: Arrival }) {
  const days = `${a.transportDays} travel day${a.transportDays === 1 ? '' : 's'}`
  if (a.fromKind === 'SHARED') {
    return <div className="whitespace-nowrap"><b>#{a.truckNumber}</b> <span className="text-gray-500">alternates with {a.from}, {fmtNum(a.miles)} mi weekly hop</span></div>
  }
  const from = a.fromKind === 'THIS_ORDER' ? `${a.from} (earlier in this order)` : a.fromKind === 'GPS' ? `${a.from} (current location)` : a.from
  if (a.outOfMarket) {
    return (
      <div className="text-amber-800">
        <b>#{a.truckNumber}</b> from {from} · {fmtNum(a.miles)} mi, {days}
        {' · '}{a.charge > 0 ? `${fmtMoney(a.charge)} billed` : a.ourCost > 0 ? `included (we absorb ${fmtMoney(a.ourCost)})` : 'included'}
      </div>
    )
  }
  return <div className="whitespace-nowrap"><b>#{a.truckNumber}</b> <span className="text-gray-500">in market · {a.miles < 1 ? `already in ${from}` : `${fmtNum(a.miles)} mi from ${from}`}</span></div>
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-gray-100 rounded-lg px-3 py-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="font-semibold text-gray-900 tabular-nums">{value}</div>
    </div>
  )
}

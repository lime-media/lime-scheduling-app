'use client'

import { ATT_RELEASE_WARNING, ATT_RELEASE_MAX_DAYS, validateReleaseRange } from '@/lib/attSoftRules'
import { QUOTE_ONLY_ORIGINATION, listedQuotes } from '@/lib/quoteOnly'
import { SERVICE_AREA_RADIUS_MILES } from '@/lib/pricing/config'
import { Fragment, useState, useEffect, useCallback, useMemo } from 'react'
import { format, formatDistanceToNow, isPast } from 'date-fns'
import toast from 'react-hot-toast'
import { CANCEL_REASON_MAX, cancelledOf } from '@/lib/cancelReason'
import { Navbar } from '@/components/Navbar'
import { TableSkeleton } from '@/components/LoadingSkeleton'
import { LedClientLink } from '@/components/LedClientLink'
import { centralDate, parseDateOnly } from '@/lib/dateOnly'
import { useReopenConfirm, type Reopenable } from '@/components/ReopenOpportunityDialog'
import { formatMarketState } from '@/lib/format'
import { parseQuoteFeatures, QuoteBreakdown } from '@/components/QuoteBreakdown'
import { AttRosterPanel, newAddDraft, type RosterDraft } from '@/components/AttRosterPanel'
import { SortableTh, SortSelect, useTableSort } from '@/components/SortableTh'
import { minValue, sortRows, type SortValue } from '@/lib/tableSort'
import { CLOSED_WON_READ_ONLY, WON_ENDED_LISTED_DAYS, bookingCapStarts, bookingEnded, bookingInLed, bookingKey, closedWonRefusal, bookingStatus, ledProgress, earliestExpiryDate, expiryEdits, isMultiMarket, marketGroups, summarizeBooking } from '@/lib/bookings'
import { STAFF_MIN_DAYS_BEFORE_START, lastExpiryDate } from '@/lib/holdExpiry'
import { defaultOwner, ownedBy, ownerOptions, runsBetween, wholeBookings, type OwnerFilter } from '@/lib/reservationFilters'
import { ATTENTION_LABEL, EXPIRING_SOON_HOURS, attentionOf, expiringSoon, groupBookings, summaryTiles, type Attention } from '@/lib/reservationView'
import { useSession } from 'next-auth/react'
import { accountUrl, opportunityUrl } from '@/lib/sfdcLinks'

type HoldRequest = {
  id: string
  truck_number: string
  market: string
  state: string
  start_date: string
  end_date: string
  notes: string
  status: string
  source: string
  origination: string
  company_name: string
  created_by_name: string | null
  /** The booking's owner: its opportunity's owner, else whoever made it (lib/reservationOwners.ts). */
  owner_id: string
  owner_name: string
  pricing_tier: string | null
  quoted_total: number | null
  daily_rate: number | null
  features: string | null
  truck_count: number | null
  campaign_group_id: string | null
  sfdc_opportunity_id: string | null
  /** Quote-only rows: when the newest hold of the opportunity was made (lib/quoteOnly.ts listedQuotes). */
  opp_latest_at?: string | null
  /** The opportunity's job number, and how LED stands on it for this truck: days run of days sold (lib/ledJobs.ts). */
  job_number: string | null
  /** The opportunity's account and its LED client, once staff have linked it (lib/ledClients.ts). */
  sfdc_account_id: string | null
  led_client: { client_uid: string; client: string | null } | null
  led_scheduled: boolean
  led_days: number
  led_days_sold: number | null
  /** The sweep moved this won hold onto the truck LED runs its job on, this week (lib/ledTruckFollow.ts). */
  led_followed: { from: string; to: string; at: string } | null
  /** Salesforce's LED Trucks has refused the moved truck for over an hour (still retried every sweep). */
  led_trucks_unsynced_since: string | null
  expires_at: string | null
  extension_reason: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  client_emailable: boolean
  client_portal: boolean
  extension_until: string | null
  created_at: string
}

/** The filter for running won bookings LED has fully scheduled; every other filter leaves them out. */
const LED_SCHEDULED = 'LED_SCHEDULED'
/**
 * The filter for won bookings whose dates have all passed, scheduled in LED or
 * not; every other filter leaves them out. They drop off a while after they
 * end (lib/bookings.ts stillListed).
 */
const WON_ENDED = 'WON_ENDED'
/**
 * The filter for quote-only logs: priced in Salesforce, nothing reserved. One
 * per opportunity until it's reserved or its start date passes
 * (lib/quoteOnly.ts listedQuotes); every other filter but All leaves them out.
 */
const QUOTES = 'QUOTES'

const STATUS_BADGE: Record<string, string> = {
  HOLD:                 'bg-yellow-100 text-yellow-800 border border-yellow-200',
  COMMITTED:            'bg-gray-100 text-gray-700 border border-gray-300',
  ATT_SOFT:             'bg-blue-100 text-blue-800 border border-blue-200',
  EXPIRED:              'bg-gray-100 text-gray-500 border border-gray-200',
  EXTENSION_REQUESTED:  'bg-amber-100 text-amber-800 border border-amber-200',
}

const STATUS_LABEL: Record<string, string> = {
  HOLD: 'Reservation',
  COMMITTED: 'Committed (won)',
  ATT_SOFT: 'AT&T Soft',
  EXPIRED: 'Expired',
  EXTENSION_REQUESTED: 'Extension Requested',
  [LED_SCHEDULED]: 'Scheduled in LED',
  [WON_ENDED]: 'Won, ended',
  [QUOTES]: 'Quotes',
}

/** Tab names where they differ from the status name. */
const TAB_LABEL: Record<string, string> = { HOLD: 'Reservations', '': 'All' }

/** The status tabs, in order: opens on Reservations; All (everything listed) is last. */
const TABS = ['HOLD', QUOTES, 'ATT_SOFT', 'EXPIRED', LED_SCHEDULED, WON_ENDED, ''] as const

const SOURCE_BADGE: Record<string, string> = {
  CLIENT:     'bg-green-50 text-green-700 border border-green-200',
  SALESFORCE: 'bg-blue-50 text-blue-700 border border-blue-200',
  INTERNAL:   'bg-gray-50 text-gray-600 border border-gray-200',
}

const SOURCE_LABEL: Record<string, string> = {
  CLIENT:     'Client',
  SALESFORCE: 'Salesforce',
  INTERNAL:   'Internal',
}

function fmtMoney(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

/** Sortable columns, in table order. */
const SORT_COLUMNS = [
  { key: 'truck', label: 'Truck' },
  { key: 'client', label: 'Client' },
  { key: 'market', label: 'Market' },
  { key: 'dates', label: 'Dates' },
  { key: 'source', label: 'Source' },
  { key: 'created_by', label: 'Created By' },
  { key: 'pricing', label: 'Pricing' },
  { key: 'status', label: 'Status' },
  { key: 'expires', label: 'Expires' },
] as const
type SortKey = typeof SORT_COLUMNS[number]['key']
const SORT_KEYS = SORT_COLUMNS.map(c => c.key)

/** What a reservation shows in each column, as a sortable value. */
function sortValue(r: HoldRequest, key: SortKey): SortValue {
  switch (key) {
    case 'truck':      return r.truck_number
    case 'client':     return r.company_name
    case 'market':     return formatMarketState(r.market, r.state)
    case 'dates':      return `${r.start_date} ${r.end_date}`
    case 'source':     return SOURCE_LABEL[r.source] ?? r.source
    case 'created_by': return r.created_by_name
    case 'pricing':    return r.quoted_total
    case 'status':     return r.origination === QUOTE_ONLY_ORIGINATION ? 'Quote only' : (STATUS_LABEL[r.status] ?? r.status)
    // Committed reservations show no expiry, so they sort with the blanks.
    case 'expires':    return r.status === 'COMMITTED' ? null : r.expires_at
  }
}

/** A campaign card sorts by its lowest truck number; everything else is shared by its trucks. */
function groupSortValue(rows: HoldRequest[], key: SortKey): SortValue {
  return key === 'truck' ? minValue(rows.map(r => r.truck_number)) : sortValue(rows[0], key)
}

/**
 * Revise a booking made in the quote tools: open it in the multi-market
 * planner to add, drop or change markets and dates on the same opportunity
 * (app/api/bookings/revise). Not for Salesforce pushes or client bookings.
 */
function ReviseLink({ rows, booking }: { rows: HoldRequest[]; booking?: HoldRequest[] }) {
  const key = rows.length ? bookingKey(rows[0]) : null
  if (!key || rows.some(r => r.source !== 'INTERNAL')) return null
  // A won deal is changed in Salesforce, never revised here (lib/bookings.ts reviseRefusal).
  if (closedWonRefusal(booking ?? rows)) return null
  // Any card of a booking with an extension request waiting: answer it first
  // (revising would drop it; lib/bookings.ts reviseRefusal).
  if ((booking ?? rows).some(r => r.status === 'EXTENSION_REQUESTED')) {
    return <span title="An extension request on this booking is waiting: approve or decline it first" className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-400 cursor-not-allowed">Revise</span>
  }
  const href = `/quote?revise=${encodeURIComponent(key)}`
  // A quote-only log: open it as quoted, or open it to reserve its trucks
  // (the planner's own booking path re-checks them and refuses what's taken).
  if (rows.every(r => r.origination === QUOTE_ONLY_ORIGINATION)) {
    return (
      <>
        <a href={href}
          title="Open the quote as logged, to change or re-log it"
          className="px-3 py-1.5 rounded-lg text-xs font-medium border border-blue-200 text-blue-700 hover:bg-blue-50 transition-colors">
          Open quote
        </a>
        <a href={`${href}&reserve=1`}
          title="Open the quote to reserve its trucks, if they're still free"
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-green-600 hover:bg-green-700 text-white transition-colors">
          Reserve
        </a>
      </>
    )
  }
  return (
    <a href={href}
      title="Add, drop or change markets and dates on the same opportunity"
      className="px-3 py-1.5 rounded-lg text-xs font-medium border border-blue-200 text-blue-700 hover:bg-blue-50 transition-colors">
      Revise
    </a>
  )
}

/** Where a won booking stands in LED: matched by its job number on each truck (lib/ledJobs.ts). */
function LedBadge({ progress, inLed, unavailable }: { progress: { days: number; of: number; known: boolean } | null; inLed: boolean; unavailable: boolean }) {
  if (!progress) return null
  if (inLed) {
    return <span className="text-xs text-green-700 font-medium" title="LED runs this job on every truck for all the days sold">Scheduled in LED</span>
  }
  if (unavailable) {
    return <span className="text-xs text-gray-500" title="The LED schedule couldn't be read, so this booking's LED status is unknown">LED status unavailable</span>
  }
  if (!progress.known) {
    return <span className="text-xs text-gray-500" title="This deal has no job number yet, so it can't be matched to an LED program">No job number yet</span>
  }
  if (progress.of === 0) {
    return <span className="text-xs text-gray-500" title="These holds sell no days for LED to run (travel or idle days only)">No LED days sold</span>
  }
  if (progress.days > 0) {
    return (
      <span className="text-xs text-amber-700 font-medium" title="Truck-days LED runs this job on the booking's trucks, of the days sold. The rest aren't scheduled, or are on another truck. The trucks stay held for every day either way.">
        In LED: {progress.days} of {progress.of} days
      </span>
    )
  }
  return <span className="text-xs text-gray-500" title="No LED program with this deal's job number on these trucks yet">Not in LED yet</span>
}

/**
 * A won booking whose truck the sweep moved to match LED this week, and any
 * whose new truck Salesforce's LED Trucks still refuses (lib/ledTruckFollow.ts).
 */
function LedFollowBadge({ rows }: { rows: HoldRequest[] }) {
  const moved = rows.filter(r => r.led_followed)
  const unsynced = rows.some(r => r.led_trucks_unsynced_since)
  if (!moved.length && !unsynced) return null
  return (
    <>
      {moved.length > 0 && (
        <span className="text-xs text-blue-700 font-medium"
          title="LED scheduled this job on another truck, so the reservation moved to it (the trucks are kept in step with LED). Salesforce's LED Trucks is updated to match.">
          Truck moved to match LED: {moved.map(r => `${r.led_followed!.from} → ${r.led_followed!.to} (${format(new Date(r.led_followed!.at), 'MMM d')})`).join(', ')}
        </span>
      )}
      {unsynced && (
        <span className="text-xs text-red-700 font-medium"
          title="The reservation moved to LED's truck over an hour ago, and the new LED Trucks hasn't reached Salesforce yet (usually a validation rule or a deleted opportunity). It's retried every 15 minutes while the campaign runs; fix the opportunity in Salesforce so it can go through.">
          LED Trucks not updated in Salesforce
        </span>
      )}
    </>
  )
}

function ExpirationBadge({ expiresAt, status, cancelled, quoteOnly = false }: { expiresAt: string | null; status: string; cancelled?: { reason: string | null } | null; quoteOnly?: boolean }) {
  // A quote-only log reserved nothing, so it has no expiry to show (it's stored EXPIRED).
  if (quoteOnly) return null
  if (status === 'EXPIRED' && cancelled) {
    return <span className="text-xs text-red-700" title={cancelled.reason ?? undefined}>Cancelled{cancelled.reason ? `: ${cancelled.reason}` : ''}</span>
  }
  if (!expiresAt || status === 'COMMITTED') return null
  const expDate = new Date(expiresAt)

  if (status === 'EXPIRED') {
    return <span className="text-xs text-gray-400">Expired</span>
  }

  // Past its expiry but not yet flipped to EXPIRED by the sweep (every 15 minutes). The
  // truck is already treated as free everywhere (see lib/holdFilters.ts) — this
  // row is just waiting on the status write, so say that rather than the old
  // "Expiring..." which read as a hold that never quite expired.
  if (isPast(expDate)) {
    return (
      <span className="text-xs text-red-500 font-medium" title="Past its expiration date — the truck is already released; the next sweep (every 15 minutes) marks it Expired.">
        Past due
      </span>
    )
  }

  const remaining = formatDistanceToNow(expDate, { addSuffix: false })
  const isUrgent = expDate.getTime() - Date.now() < 12 * 60 * 60 * 1000 // < 12h
  return (
    <span className={`text-xs ${isUrgent ? 'text-amber-600 font-medium' : 'text-gray-400'}`}>
      {remaining} left
    </span>
  )
}

function PricingBadge({ tier, total }: { tier: string | null; total: number | null }) {
  if (!tier) return <span className="text-xs text-gray-400">No quote</span>
  const colors: Record<string, string> = {
    Good:   'bg-green-50 text-green-700 border-green-200',
    Better: 'bg-blue-50 text-blue-700 border-blue-200',
    Best:   'bg-purple-50 text-purple-700 border-purple-200',
  }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${colors[tier] ?? 'bg-gray-50 text-gray-600 border-gray-200'}`}>
      {tier}{total ? ` · ${fmtMoney(total)}` : ''}
    </span>
  )
}

/** A booking as its table row and detail show it: the same rows behind its total, status, expiry and actions. */
type BookingView = {
  rows: HoldRequest[]
  /** The booking's one status, and markets out of step in an older booking (lib/bookings.ts bookingStatus). */
  status: string
  odd: { status: string; markets: string[] }[]
  /** The row the booking speaks for: one in its status. */
  first: HoldRequest
  /** What its actions act on: its holds in the booking's status. */
  ids: string[]
  multi: boolean
  summary: ReturnType<typeof summarizeBooking>
  /** The expiry to act on: the booking's live holds'. */
  expiry: string | null
  quoteOnly: boolean
  anyQuoteOnly: boolean
  key: string | null
  /** Every row of the booking across all statuses (for Revise). */
  booking: HoldRequest[]
  trucks: number
  marketsLabel: string
  datesLabel: string
  flags: Attention[]
}

const TH_CELL = 'text-left px-3 py-3 font-semibold text-gray-500 text-xs uppercase tracking-wider'

/** A summary tile over the bookings shown; clicking it narrows the list to them. */
function SummaryTile({ title, value, detail, tone, active, onClick }: { title: string; value: string; detail: string; tone?: 'amber' | 'red'; active?: boolean; onClick: () => void }) {
  const accent = tone === 'amber' ? 'text-amber-700' : tone === 'red' ? 'text-red-700' : 'text-gray-500'
  return (
    <button onClick={onClick} aria-pressed={active}
      className={`text-left bg-white rounded-xl border px-4 py-3 shadow-sm transition-colors min-w-0 ${active ? 'border-green-600 ring-1 ring-green-600' : 'border-gray-200 hover:border-gray-300'}`}>
      <div className={`text-xs font-medium ${accent}`}>{title}</div>
      <div className="text-xl sm:text-2xl font-bold text-gray-900 mt-0.5">{value}</div>
      <div className="text-xs text-gray-500 mt-0.5 break-words">{detail}</div>
    </button>
  )
}

/** The booking's price as its card showed it: a summed total for a multi-market booking, with any unpriced markets named. */
function BookingPrice({ v }: { v: BookingView }) {
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <PricingBadge tier={v.multi ? v.summary.tier : v.first.pricing_tier} total={v.multi ? v.summary.total : v.first.quoted_total} />
      {v.multi && v.summary.unpricedMarkets > 0 && (
        <span className="text-xs text-amber-700" title="These markets have no price on file; the total leaves them out">
          + {v.summary.unpricedMarkets} unpriced
        </span>
      )}
    </span>
  )
}

function StatusPill({ v }: { v: BookingView }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${STATUS_BADGE[v.status] ?? STATUS_BADGE.HOLD}`}>
      {v.first.origination === QUOTE_ONLY_ORIGINATION ? 'Quote only' : (STATUS_LABEL[v.status] ?? v.status)}
    </span>
  )
}

/** Time left and the expiry date (Central), and the first thing that needs attention. */
function ExpiryCell({ v }: { v: BookingView }) {
  const live = (v.status === 'HOLD' || v.status === 'EXTENSION_REQUESTED') && !v.quoteOnly && v.expiry && !isPast(new Date(v.expiry))
  return (
    <div className="flex flex-col gap-0.5">
      <ExpirationBadge expiresAt={v.expiry} status={v.status} cancelled={cancelledOf(v.rows)} quoteOnly={v.quoteOnly} />
      {live && <span className="text-xs text-gray-700">{format(parseDateOnly(centralDate(new Date(v.expiry!))), 'EEE, MMM d')}</span>}
      {v.flags.length > 0 && (
        <span className="text-xs text-red-700" title={v.flags.map(f => ATTENTION_LABEL[f]).join('\n')}>
          ⚠ {ATTENTION_LABEL[v.flags[0]]}{v.flags.length > 1 ? ` +${v.flags.length - 1}` : ''}
        </span>
      )}
    </div>
  )
}

type AvailableTruck = {
  truckNumber: string
  current: boolean
  /** Where the truck departs from for these dates — not where it is today. */
  departsFrom: string
  /** True when departsFrom is a commitment (projection), false when it is GPS. */
  originIsCommitment: boolean
  gpsMarket: string | null
  distanceMiles: number
  needsTransport: boolean
  transportDays: number
  transportCharge: number
  requiresOverride: boolean
  /** Leaves a later AT&T soft hold short of travel time (allowed, flagged). */
  softHoldWarning: string | null
}

export default function HoldRequestsPage() {
  const [requests,     setRequests]     = useState<HoldRequest[]>([])
  const [loading,      setLoading]      = useState(true)
  const [filterStatus, setFilterStatus] = useState<string>('HOLD')
  // One remembered sort per status tab: AT&T soft holds by truck need not
  // reorder the reservations tab.
  const { sort, sortBy, chooseSort } = useTableSort<SortKey>(`reservations.sort.${filterStatus || 'all'}`, SORT_KEYS)
  const [search,       setSearch]       = useState('')
  // Whose reservations, and which dates they run (lib/reservationFilters.ts).
  // The owner choice is remembered per browser; the dates are not.
  const { data: session } = useSession()
  const meId = session?.user?.id ?? null
  // null: nothing remembered on this browser, so the page opens on Me for
  // someone who owns a listed reservation, else Everyone (defaultOwner).
  const [owner, setOwnerState] = useState<OwnerFilter | null>(null)
  // Remembered per login, so a shared browser doesn't hand one person's choice to the next.
  const ownerKey = meId ? `reservations.owner.${meId}` : null
  useEffect(() => {
    if (!ownerKey) return
    try { setOwnerState(localStorage.getItem(ownerKey)) } catch { /* storage unavailable */ }
  }, [ownerKey])
  const setOwner = (value: OwnerFilter) => {
    setOwnerState(value)
    if (ownerKey) try { localStorage.setItem(ownerKey, value) } catch { /* storage unavailable */ }
  }
  // The choices, and the owner actually applied: a remembered owner that is no
  // longer a choice (their reservations have all dropped off, another user on
  // this browser, or the session still loading for "Me") falls back to
  // Everyone, so the dropdown and the list always agree.
  const owners = useMemo(() => ownerOptions(requests, meId), [requests, meId])
  const ownerWanted = owner ?? defaultOwner(requests, meId)
  const ownerShown: OwnerFilter = owners.some(o => o.value === ownerWanted) ? ownerWanted : 'all'
  const ownerLabel = owners.find(o => o.value === ownerShown)?.label ?? 'Everyone'
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo,   setDateTo]   = useState('')
  // Keep From <= To: moving one end past the other moves both.
  const chooseFrom = (v: string) => { setDateFrom(v); if (v && dateTo && v > dateTo) setDateTo(v) }
  const chooseTo   = (v: string) => { setDateTo(v); if (v && dateFrom && v < dateFrom) setDateFrom(v) }
  const [acting,       setActing]       = useState<string | null>(null) // group/row id currently mid-action
  // Reinstating onto a Closed Lost opportunity: asked before it is moved back to WARM.
  const reopen = useReopenConfirm()

  // Edit modal state — supports multi-truck reservations
  const [editingGroup, setEditingGroup] = useState<HoldRequest[] | null>(null)
  const [availableTrucksMap, setAvailableTrucksMap] = useState<Map<string, AvailableTruck[]>>(new Map())
  const [trucksLoading, setTrucksLoading] = useState(false)
  const [selectedTrucks, setSelectedTrucks] = useState<Map<string, string>>(new Map()) // holdId -> selected truck
  const [cancelMode, setCancelMode] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [newExpiresAt, setNewExpiresAt] = useState('')
  // Whether staff changed the expiry field (it opens on the soonest expiry).
  const [expiryEdited, setExpiryEdited] = useState(false)
  const [expiredWindowDays, setExpiredWindowDays] = useState<number | null>(null)
  // The LED schedule couldn't be read: won bookings' LED badges say so.
  const [ledUnavailable, setLedUnavailable] = useState(false)
  // The org's address for the Salesforce links on each card; null when it couldn't be read.
  const [sfdcBase, setSfdcBase] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // A change to the AT&T truck list being drafted (components/AttRosterPanel.tsx).
  const [rosterDraft, setRosterDraft] = useState<RosterDraft | null>(null)

  // Releasing part of an AT&T soft hold for a booking (lib/attSoftRelease.ts).
  const [softRelease, setSoftRelease] = useState<{ hold: HoldRequest; start: string; end: string; context: string } | null>(null)
  const softReleaseError = softRelease
    ? (!softRelease.start || !softRelease.end
        ? 'Pick the booking\'s dates.'
        : softRelease.start < softRelease.hold.start_date || softRelease.end > softRelease.hold.end_date
          ? `Dates must fall within this soft hold (${softRelease.hold.start_date} to ${softRelease.hold.end_date}).`
          : validateReleaseRange(softRelease.start, softRelease.end)
            ?? (softRelease.context.trim() ? null : 'Say which booking this is for.'))
    : null

  const submitSoftRelease = async () => {
    if (!softRelease || softReleaseError) return
    if (!confirm(ATT_RELEASE_WARNING)) return
    setSaving(true)
    try {
      const res = await fetch('/api/holds/att-soft/release', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          truck_number: softRelease.hold.truck_number,
          start_date: softRelease.start, end_date: softRelease.end,
          context: `Reservations: ${softRelease.context.trim()}`,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Release failed')
      toast.success(data.message)
      setSoftRelease(null)
      fetchRequests()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Release failed')
    } finally {
      setSaving(false)
    }
  }

  const fetchRequests = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/hold-requests')
      if (!res.ok) throw new Error()
      const data = await res.json()
      setRequests(data.holdRequests || [])
      setExpiredWindowDays(typeof data.expired_window_days === 'number' ? data.expired_window_days : null)
      setLedUnavailable(data.led_unavailable === true)
      setSfdcBase(typeof data.sfdc_base_url === 'string' ? data.sfdc_base_url : null)
    } catch (err) {
      toast.error('Failed to load hold requests')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchRequests() }, [fetchRequests])

  // Approve or deny an extension, or reinstate: ONE request for the whole
  // booking (the server acts on every hold in it, in one transaction: a
  // reinstate comes back whole or is refused whole, naming any truck taken
  // since it lapsed), then a refetch so the list reflects what landed.
  const runAction = useCallback(async (allIds: string[], action: 'approve' | 'reject' | 'approve_extension' | 'deny_extension' | 'reinstate', groupKey: string) => {
    setActing(groupKey)
    try {
      const send = async (reopenOpportunity = false, expiresAt?: string): Promise<{ ok: boolean; error?: string; reopenable?: Reopenable; lastDate?: string; holds?: number; sfdcWarning?: string | null }> => {
        const res = await fetch(`/api/hold-requests/${allIds[0]}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ action, ...(reopenOpportunity ? { reopenOpportunity: true } : {}), ...(expiresAt ? { expires_at: expiresAt } : {}) }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) return { ok: false, error: body.error || 'Failed', reopenable: body.reopenable, lastDate: body.lastDate }
        return { ok: true, holds: body.holds, sfdcWarning: body.sfdcWarning ?? null }
      }
      let result = await send()
      // Reinstating onto a Closed Lost opportunity: ask once, then send it again.
      if (result.reopenable && await reopen.ask(result.reopenable.question)) result = await send(true)
      // The client's date is past the staff limit (lib/expiryRules.ts refuses
      // it rather than cutting it back): offer the limit, said out loud.
      if (action === 'approve_extension' && result.lastDate
        && confirm(`${result.error}\n\nApprove it until ${format(parseDateOnly(result.lastDate), 'EEE, MMM d')} instead? The client is emailed that date.`)) {
        result = await send(false, result.lastDate)
      }

      const actionLabel = action.replace('_', ' ')
      if (result.ok) {
        // A reinstated hold is no longer EXPIRED, so it leaves whichever expired view the
        // button was clicked from. Follow it to Reservations rather than letting the row vanish.
        if (action === 'reinstate') setFilterStatus('HOLD')
        const trucks = result.holds ?? allIds.length
        toast.success(`${actionLabel} — ${trucks} truck${trucks === 1 ? '' : 's'}`)
        // Saved here, but Salesforce's LED fields weren't updated: say so, and keep it up.
        if (result.sfdcWarning) toast.error(result.sfdcWarning, { duration: 15000 })
      } else {
        toast.error(result.error || `Failed to ${actionLabel}`)
      }
    } finally {
      setActing(null)
      fetchRequests()
    }
  }, [fetchRequests]) // eslint-disable-line react-hooks/exhaustive-deps

  const openEdit = async (request: HoldRequest) => {
    // Everything in the same booking: all markets of a multi-market quote,
    // so one Edit (and one expiry change, or one cancel) covers the whole
    // reservation, as its card does. Its live reservations only: an expired
    // part of an older booking has no truck to swap or date to move.
    const key = bookingKey(request)
    const siblings = (key ? rowsByBooking.get(key) ?? [request] : [request])
      .filter(r => r.status === 'HOLD' || r.status === 'COMMITTED' || r.status === 'EXTENSION_REQUESTED')
    setEditingGroup(siblings)
    setSelectedTrucks(new Map(siblings.map(r => [r.id, r.truck_number])))
    setCancelMode(false)
    setCancelReason('')
    // The soonest expiry, the one the card's badge shows.
    setNewExpiresAt(earliestExpiryDate(siblings))
    setExpiryEdited(false)
    setAvailableTrucksMap(new Map())
    setTrucksLoading(true)
    try {
      const results = await Promise.all(
        siblings.map(async (r) => {
          const res = await fetch(`/api/hold-requests/${r.id}/available-trucks`)
          if (res.ok) {
            const data = await res.json()
            return [r.id, data.trucks] as [string, AvailableTruck[]]
          }
          return [r.id, []] as [string, AvailableTruck[]]
        })
      )
      setAvailableTrucksMap(new Map(results))
    } catch {
      // Truck pickers won't show alternatives
    } finally {
      setTrucksLoading(false)
    }
  }

  const handleSaveEdits = async () => {
    if (!editingGroup) return
    const truckChanges = editingGroup.filter(r => selectedTrucks.get(r.id) !== r.truck_number)
    // A date past the booking's limit is blocked here, not saved and cut back.
    if (expiryEdited && newExpiresAt && editLastDate && newExpiresAt > editLastDate) {
      toast.error(`The latest this booking can be held is ${format(parseDateOnly(editLastDate), 'MMM d')}: ${STAFF_MIN_DAYS_BEFORE_START} days before its first market starts.`)
      return
    }
    // Only when the date was edited (saving untouched changes nothing). Every
    // hold of the card gets the one date: a booking has one expiry (lib/bookings.ts).
    const expiryChanges = expiryEdited && newExpiresAt
      ? expiryEdits(editingGroup, newExpiresAt).filter(e => e.changed)
      : []
    const expirationChanged = expiryChanges.length > 0

    if (truckChanges.length === 0 && !expirationChanged) {
      setEditingGroup(null)
      return
    }

    // Any chosen truck that is AT&T soft-held for this request: warn, then
    // release the soft hold for this request's dates only, before swapping.
    const needsRelease = truckChanges.filter(r => {
      const t = availableTrucksMap.get(r.id)?.find(x => x.truckNumber === selectedTrucks.get(r.id))
      return t?.requiresOverride
    })
    if (needsRelease.length > 0 && !confirm(ATT_RELEASE_WARNING)) return

    setSaving(true)
    try {
      for (const r of needsRelease) {
        const res = await fetch('/api/holds/att-soft/release', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            truck_number: selectedTrucks.get(r.id), start_date: r.start_date, end_date: r.end_date,
            context: `Client request: ${r.company_name}, ${r.market}, ${r.start_date} to ${r.end_date}`,
          }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          toast.error(err.error || 'Could not release the AT&T soft hold')
          return
        }
      }

      // Truck swaps, one at a time: each syncs Salesforce's LED Trucks from
      // what the app holds, so the next swap's sync sees the one before it.
      if (truckChanges.length > 0) {
        const results: { ok: boolean; error?: string; sfdcWarning?: string | null }[] = []
        for (const r of truckChanges) {
          const newTruck = selectedTrucks.get(r.id)
          if (!newTruck) { results.push({ ok: true }); continue }
          const res = await fetch(`/api/hold-requests/${r.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'swap_truck', truck_number: newTruck }),
          })
          const body = await res.json().catch(() => ({}))
          results.push(res.ok ? { ok: true, sfdcWarning: body.sfdcWarning ?? null } : { ok: false, error: body.error })
        }
        const failed = results.filter(r => !r.ok)
        if (failed.length > 0) {
          toast.error(failed[0].error || 'Some swaps failed')
        }
        // The swap saved, but Salesforce's LED Trucks didn't follow: say so.
        for (const w of new Set(results.map(r => r.sfdcWarning).filter(Boolean))) toast.error(w!, { duration: 15000 })
      }

      // Expiration update — ONE request: the server sets the one date on every
      // live hold of the booking, in one transaction (see expiryChanges).
      if (expirationChanged) {
        const res = await fetch(`/api/hold-requests/${expiryChanges[0].id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update_expiration', expires_at: expiryChanges[0].expiresOn }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast.error(`Expiry not changed: ${body.error || 'request failed'}`)
          fetchRequests()
          return
        }
        // Saved here, but Salesforce's LED fields weren't updated: say so, and keep it up.
        if (body.sfdcWarning) toast.error(body.sfdcWarning, { duration: 15000 })
      }

      toast.success('Reservation updated')
      setEditingGroup(null)
      fetchRequests()
    } catch {
      toast.error('Network error')
    } finally {
      setSaving(false)
    }
  }

  const handleCancelNotify = async () => {
    if (!editingGroup || !cancelReason.trim()) return
    setSaving(true)
    try {
      // ONE request: the server cancels every live hold of the booking in one
      // transaction and sends the client one email.
      const res = await fetch(`/api/hold-requests/${editingGroup[0].id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel_notify', reason: cancelReason }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        toast.success(data.emailed ? 'Reservation cancelled — client notified' : 'Reservation cancelled')
        if (data.sfdcWarning) toast.error(data.sfdcWarning, { duration: 15000 })
      } else {
        toast.error(data.error || 'Reservation not cancelled')
      }
      setEditingGroup(null)
      fetchRequests()
    } catch {
      toast.error('Network error')
    } finally {
      setSaving(false)
    }
  }

  // Every reservation by booking, across all statuses. A booking is the unit
  // (one card, one status: lib/bookings.ts bookingStatus). Built once per
  // fetch, not per card per render.
  const rowsByBooking = useMemo(() => {
    const out = new Map<string, HoldRequest[]>()
    for (const r of requests) {
      const key = bookingKey(r)
      if (key) out.set(key, [...(out.get(key) ?? []), r])
    }
    return out
  }, [requests])

  // A booking's status (and its markets in any other status, for an older booking).
  const statusOf = useCallback((r: HoldRequest) => {
    const key = bookingKey(r)
    return key ? bookingStatus(rowsByBooking.get(key) ?? [r]) : { status: r.status, odd: [] }
  }, [rowsByBooking])

  // A won booking LED has fully scheduled: listed only under its own filter.
  // One whose truck moved to match LED this week, or whose new truck hasn't
  // reached Salesforce, stays in the main list: its badge is the news.
  const inLedOf = useCallback((r: HoldRequest) => {
    const key = bookingKey(r)
    const rows = key ? rowsByBooking.get(key) ?? [r] : [r]
    return bookingInLed(rows) && !rows.some(x => x.led_followed || x.led_trucks_unsynced_since)
  }, [rowsByBooking])

  // The quote-only logs listed under Quotes (one per opportunity, until it's
  // reserved or starts). Read over every row, not the search, so a search
  // never brings back a superseded quote.
  const quoteKeys = useMemo(
    () => listedQuotes(requests, r => bookingKey(r) ?? r.id, centralDate(new Date())),
    [requests],
  )

  // A won booking whose dates have all passed: listed only under its own filter.
  // Today (Central) is read once per fetch, not once per row.
  const endedOf = useMemo(() => {
    const today = centralDate(new Date())
    return (r: HoldRequest) => {
      const key = bookingKey(r)
      return bookingEnded(key ? rowsByBooking.get(key) ?? [r] : [r], today)
    }
  }, [rowsByBooking])

  // Owner, dates and search pick whole bookings: a booking shows if any of
  // it matches, so a card, its total and its Edit always cover the same
  // reservations and a multi-market card never loses a market. The list and
  // the Reservations tab's request count both read this, so they agree.
  const narrowed = useMemo(() => {
    let result = requests
    if (ownerShown !== 'all' || dateFrom || dateTo) {
      result = wholeBookings(result, r => ownedBy(r, ownerShown, meId) && runsBetween(r, dateFrom, dateTo))
    }
    const q = search.trim().toLowerCase()
    if (q) {
      result = wholeBookings(result, r => [r.company_name, r.truck_number, r.market, r.notes]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(q)))
    }
    return result
  }, [requests, search, ownerShown, meId, dateFrom, dateTo])

  // Bookings waiting on a client's extension request, counted on the
  // Reservations tab now that they have no tab of their own. A booking with
  // one is EXTENSION_REQUESTED (it outranks every other status), so a row's
  // own status is enough.
  const extensionRequests = useMemo(
    () => new Set(narrowed.filter(r => r.status === 'EXTENSION_REQUESTED').map(r => bookingKey(r) ?? r.id)).size,
    [narrowed],
  )

  // A filter picks whole bookings by the booking's status, never part of one.
  const inTab = useCallback((r: HoldRequest, tab: string) => {
    // Quote-only logs: under Quotes and All only, while listed.
    if (r.origination === QUOTE_ONLY_ORIGINATION) return (tab === QUOTES || !tab) && quoteKeys.has(bookingKey(r) ?? r.id)
    if (tab === QUOTES) return false
    if (tab === LED_SCHEDULED) return inLedOf(r) && !endedOf(r)
    if (tab === WON_ENDED) return endedOf(r)
    // All is everything listed, scheduled-in-LED and ended included.
    if (!tab) return true
    if (inLedOf(r) || endedOf(r)) return false
    const { status } = statusOf(r)
    return tab === 'HOLD'
      // A booking waiting on an extension request is still a reservation:
      // listed here, its card marked Extension Requested (no tab of its own).
      ? status === 'HOLD' || status === 'COMMITTED' || status === 'EXTENSION_REQUESTED'
      : status === tab
  }, [statusOf, inLedOf, endedOf, quoteKeys])

  // The owner, dates and search chosen, as bookings, for the summary tiles
  // (whatever the tab) and the tiles' quick filters (lib/reservationView.ts).
  const narrowedBookings = useMemo(() => groupBookings(narrowed), [narrowed])
  const tiles = useMemo(() => summaryTiles(narrowedBookings, new Date(), centralDate(new Date())), [narrowedBookings])
  // A tile clicked: only the bookings expiring soon, or needing attention, across every tab.
  const [quick, setQuick] = useState<'expiring' | 'attention' | null>(null)
  const quickKeys = useMemo(() => {
    if (!quick) return null
    const now = new Date()
    return new Set(narrowedBookings
      .filter(b => (quick === 'expiring' ? expiringSoon(b.rows, now) !== null : attentionOf(b.rows).length > 0))
      .flatMap(b => b.rows.map(r => r.id)))
  }, [quick, narrowedBookings])

  // How many bookings each tab lists, for its label.
  const tabCounts = useMemo(() => {
    const out = new Map<string, number>()
    for (const tab of TABS) {
      out.set(tab, new Set(narrowed.filter(r => inTab(r, tab)).map(r => bookingKey(r) ?? r.id)).size)
    }
    return out
  }, [narrowed, inTab])

  const filtered = useMemo(
    () => (quickKeys ? narrowed.filter(r => quickKeys.has(r.id)) : narrowed.filter(r => inTab(r, filterStatus))),
    [narrowed, filterStatus, inTab, quickKeys]
  )

  // The last date the card being edited can be held to: a booking has one
  // expiry, capped 2 days before its earliest start (lib/holdExpiry.ts). The
  // date field won't go past it and the server refuses it.
  const editLastDate = useMemo(() => {
    if (!editingGroup?.length) return ''
    const key = bookingKey(editingGroup[0])
    const starts = bookingCapStarts((key ? rowsByBooking.get(key) : undefined) ?? editingGroup, centralDate(new Date()))
    return lastExpiryDate([...starts].sort()[0], new Date(), STAFF_MIN_DAYS_BEFORE_START)
  }, [editingGroup, rowsByBooking])

  // One table row per booking (lib/bookings.ts bookingKey): multi-truck and
  // multi-market reservations are reviewed and managed as one unit, so a
  // row's total, status, expiry and actions cover all of it. Then the chosen
  // sort orders the bookings and the trucks within each; with none chosen,
  // the API's order (newest first) stands. Memoized with the filter above, so
  // typing in a dialog does not regroup and re-sort the list.
  const sortedBookings = useMemo(() => sortRows(
    groupBookings(filtered).map(b => ({ key: b.key, rows: sortRows(b.rows, sort, sortValue) })),
    sort,
    (b, key) => groupSortValue(b.rows, key),
  ), [filtered, sort])

  // Which bookings' rows are open to show their detail.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (key: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  function Actions({ ids, status, groupKey, requests: actionRequests, quoteOnly = false }: { ids: string[]; status: string; groupKey: string; requests?: HoldRequest[]; quoteOnly?: boolean }) {
    const busy = acting === groupKey
    if (status === 'EXTENSION_REQUESTED') {
      return (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            disabled={busy}
            onClick={() => runAction(ids, 'approve_extension', groupKey)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50 transition-colors"
          >
            Approve Extension
          </button>
          <button
            disabled={busy}
            onClick={() => runAction(ids, 'deny_extension', groupKey)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            Deny Extension
          </button>
        </div>
      )
    }
    if (status === 'EXPIRED') {
      // A quote-only log is not a lapsed reservation: nothing to reinstate.
      // Its Open quote and Reserve links come with ReviseLink.
      if (quoteOnly) return null
      return (
        <button
          disabled={busy}
          onClick={() => runAction(ids, 'reinstate', groupKey)}
          className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          Reinstate
        </button>
      )
    }
    if (status === 'ATT_SOFT' && actionRequests?.length === 1) {
      const hold = actionRequests[0]
      return (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setSoftRelease({ hold, start: '', end: '', context: '' })}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-purple-200 text-purple-700 hover:bg-purple-50 transition-colors"
          >
            Release dates
          </button>
          <button
            onClick={() => setRosterDraft({ ...newAddDraft(), action: 'REMOVE', truck_number: hold.truck_number })}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            Take off list
          </button>
        </div>
      )
    }
    if (['HOLD', 'COMMITTED'].includes(status)) {
      return (
        <div className="flex items-center gap-2">
          {actionRequests && actionRequests.length === 1 && (
            <button
              onClick={() => openEdit(actionRequests[0])}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
            >
              Edit
            </button>
          )}
        </div>
      )
    }
    return null
  }

  // A booking's row figures: the same ones its card showed (lib/bookings.ts).
  const bookingView = (rows: HoldRequest[]): BookingView => {
    // `odd` is only ever set for a booking made before the one-expiry rule
    // (#118) whose markets lapsed apart.
    const { status, odd } = bookingStatus(rows)
    const first = rows.find(g => g.status === status) ?? rows[0]
    const multi = isMultiMarket(first)
    const summary = summarizeBooking(rows)
    const key = bookingKey(first)
    return {
      rows, status, odd, first, multi, summary, key,
      ids: rows.filter(g => g.status === status).map(g => g.id),
      expiry: summarizeBooking(rows.filter(g => g.status === status)).earliestExpiry,
      quoteOnly: rows.every(g => g.origination === QUOTE_ONLY_ORIGINATION),
      anyQuoteOnly: rows.some(g => g.origination === QUOTE_ONLY_ORIGINATION),
      booking: (key ? rowsByBooking.get(key) : undefined) ?? rows,
      trucks: rows.length === 1 ? 1 : multi ? summary.trucks : (first.truck_count ?? rows.length),
      marketsLabel: [...new Set(rows.map(r => formatMarketState(r.market, r.state)))].join(' · '),
      datesLabel: `${format(parseDateOnly(summary.start), 'MMM d')} – ${format(parseDateOnly(summary.end), 'MMM d, yyyy')}`,
      flags: attentionOf(rows),
    }
  }

  // An opened booking: its flight and trucks, its quote, its Salesforce and
  // LED standing, and every action its card had.
  const renderDetail = (groupKey: string, rows: HoldRequest[], v: BookingView) => {
    const { status, first, multi } = v
    // One market's breakdown would misstate a multi-market booking.
    const parsedFeatures = multi ? null : parseQuoteFeatures(first.features)
    const panel = 'bg-white rounded-lg border border-gray-200 p-3 min-w-0'
    const panelTitle = 'text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2'
    return (
      <div className="space-y-3">
        {v.odd.length > 0 && (
          // Only an older booking (before #118) can be split; the row stays whole.
          <div className="px-3 py-1.5 rounded-lg text-xs text-amber-800 bg-amber-50 border border-amber-100">
            Older booking with markets out of step:{' '}
            {v.odd.map(o => `${o.markets.join(', ')} ${STATUS_LABEL[o.status] ?? o.status}`).join('; ')}.
            {' '}Actions here apply to the {STATUS_LABEL[status] ?? status} markets.
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Flight and trucks: each market in flight order, then its trucks. */}
          <div className={panel}>
            <div className={panelTitle}>Flight &amp; trucks</div>
            {multi ? (
              <div className="space-y-2">
                {marketGroups(rows).map((m) => (
                  <div key={m.key} className="text-sm">
                    <div className="font-semibold text-gray-900">{formatMarketState(m.market, m.rows[0].state)}</div>
                    <div className="text-xs text-gray-600">
                      {format(parseDateOnly(m.start), 'MMM d')} &ndash; {format(parseDateOnly(m.end), 'MMM d, yyyy')}
                      {' · '}{m.days} {m.daysKind === 'activation' ? 'activation' : 'calendar'} day{m.days === 1 ? '' : 's'}
                    </div>
                    <div className="text-xs text-gray-700 mt-0.5">
                      {m.rows.map((r, i) => (
                        <span key={r.id}>
                          {i > 0 && ', '}Truck {r.truck_number}
                          {/* A truck's own dates, when it covers only part of the market's (alternating trucks). */}
                          {(r.start_date.slice(0, 10) !== m.start || r.end_date.slice(0, 10) !== m.end) && (
                            <span className="text-gray-500"> ({format(parseDateOnly(r.start_date), 'MMM d')} &ndash; {format(parseDateOnly(r.end_date), 'MMM d')})</span>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm">
                <div className="font-semibold text-gray-900">{v.marketsLabel}</div>
                <div className="text-xs text-gray-600">{v.datesLabel}</div>
                <div className="mt-1 space-y-0.5">
                  {rows.map((r) => (
                    <div key={r.id} className="text-xs text-gray-700">
                      Truck <span className="font-medium text-gray-900">{r.truck_number}</span>
                      {(r.start_date !== v.summary.start || r.end_date !== v.summary.end) && (
                        <span className="text-gray-500"> ({format(parseDateOnly(r.start_date), 'MMM d')} &ndash; {format(parseDateOnly(r.end_date), 'MMM d')})</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* The quote, as stored on the booking. */}
          <div className={`${panel} overflow-x-auto`}>
            <div className={panelTitle}>Quote</div>
            {parsedFeatures ? (
              <QuoteBreakdown features={parsedFeatures} />
            ) : multi ? (
              <div className="text-sm space-y-1">
                {marketGroups(rows).map((m) => (
                  <div key={m.key} className="flex items-center justify-between gap-2">
                    <span className="text-gray-700 min-w-0 break-words">{formatMarketState(m.market, m.rows[0].state)}</span>
                    <span className="tabular-nums text-gray-900">{m.rows[0].quoted_total != null ? fmtMoney(m.rows[0].quoted_total) : 'No quote'}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between gap-2 border-t border-gray-200 pt-1 font-semibold">
                  <span>Total{v.summary.unpricedMarkets > 0 ? ` (${v.summary.unpricedMarkets} market${v.summary.unpricedMarkets === 1 ? '' : 's'} unpriced)` : ''}</span>
                  <span className="tabular-nums">{v.summary.total != null ? fmtMoney(v.summary.total) : '—'}</span>
                </div>
              </div>
            ) : (
              <PricingBadge tier={first.pricing_tier} total={first.quoted_total} />
            )}
          </div>

          {/* Who it's for and where it stands in Salesforce and LED. */}
          <div className={panel}>
            <div className={panelTitle}>Salesforce &amp; LED</div>
            <dl className="text-xs grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
              <dt className="text-gray-500">Owner</dt><dd className="text-gray-900 break-words">{first.owner_name || '—'}</dd>
              <dt className="text-gray-500">Created by</dt><dd className="text-gray-900 break-words">{first.created_by_name || '—'}</dd>
              <dt className="text-gray-500">Source</dt>
              <dd>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${SOURCE_BADGE[first.source] ?? SOURCE_BADGE.INTERNAL}`}>
                  {SOURCE_LABEL[first.source] ?? first.source}
                </span>
              </dd>
              {first.job_number && (<><dt className="text-gray-500">Job number</dt><dd className="text-gray-900">{first.job_number}</dd></>)}
            </dl>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <SalesforceLinks base={sfdcBase} rows={rows} />
              <LedBadge progress={ledProgress(rows)} inLed={bookingInLed(rows)} unavailable={ledUnavailable} />
              {status === 'COMMITTED' && first.sfdc_account_id && (
                <LedClientLink accountId={first.sfdc_account_id} linked={first.led_client} onSaved={fetchRequests} />
              )}
              <LedFollowBadge rows={rows} />
            </div>
            {v.flags.length > 0 && (
              <ul className="mt-2 px-2.5 py-1.5 rounded-lg bg-red-50 border border-red-100 text-xs text-red-800 space-y-0.5">
                {v.flags.map(f => <li key={f}>{ATTENTION_LABEL[f]}</li>)}
              </ul>
            )}
          </div>
        </div>

        {status === 'EXTENSION_REQUESTED' && (
          <div className="px-3 py-2 rounded-lg text-xs text-amber-800 bg-amber-50 border border-amber-100">
            Extension requested for the whole booking{first.extension_until ? ` until ${format(parseDateOnly(centralDate(new Date(first.extension_until))), 'MMM d')}` : ''}.
            {first.extension_reason ? ` Reason: ${first.extension_reason}` : ''}
          </div>
        )}
        {status === 'COMMITTED' && closedWonRefusal(rows) && (
          <div className="px-3 py-1.5 rounded-lg text-xs text-gray-600 bg-gray-50 border border-gray-100">
            Closed Won: only a truck swap can be made here. Change anything else in Salesforce.
          </div>
        )}

        {/* The booking's actions, as its card had them. */}
        <div className="flex items-center gap-2 flex-wrap">
          {status === 'HOLD' || status === 'COMMITTED' ? (
            <button
              onClick={() => openEdit(first)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 bg-white hover:bg-gray-50 transition-colors"
            >
              {closedWonRefusal(rows) ? 'Swap trucks' : 'Edit'}
            </button>
          ) : (
            <Actions ids={v.ids} status={status} groupKey={groupKey} requests={rows} quoteOnly={v.anyQuoteOnly} />
          )}
          {(status === 'HOLD' || status === 'COMMITTED' || status === 'EXPIRED') && <ReviseLink rows={rows} booking={v.booking} />}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-dvh bg-gray-50">
      <Navbar />
      {reopen.dialog}

      <div className="flex-1 p-4 sm:p-6 max-w-7xl mx-auto w-full">
        {/* Header: whose reservations, and what the page is showing */}
        <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900">Reservations</h1>
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <label htmlFor="reservations-owner" className="text-sm text-gray-600">Owner</label>
              <select
                id="reservations-owner"
                value={ownerShown}
                onChange={(e) => setOwner(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm font-medium bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
              >
                {owners.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <span className="text-xs text-gray-500">
                {sortedBookings.length} booking{sortedBookings.length === 1 ? '' : 's'} shown · Owner: {ownerLabel}
              </span>
            </div>
            {expiredWindowDays !== null && !quick && (filterStatus === '' || filterStatus === 'EXPIRED') && (
              <p className="text-xs text-gray-400 mt-1">
                Showing expired reservations from the last {expiredWindowDays} days. Older ones are kept but not listed here.
              </p>
            )}
            {filterStatus === QUOTES && !quick && (
              <p className="text-xs text-gray-400 mt-1">
                Quotes logged to Salesforce with no trucks reserved: the latest for each opportunity, until it&apos;s reserved or its start date passes.
              </p>
            )}
            {(filterStatus === WON_ENDED || filterStatus === '') && !quick && (
              <p className="text-xs text-gray-400 mt-1">
                Won bookings are listed for {WON_ENDED_LISTED_DAYS.inLed} days after they end once LED has fully scheduled them, and {WON_ENDED_LISTED_DAYS.notInLed} days if it hasn&apos;t.
              </p>
            )}
          </div>
        </div>

        {/* Summary for the owner, dates and search chosen (lib/reservationView.ts). */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <SummaryTile
            title="Open reservations"
            value={fmtMoney(tiles.open.value)}
            detail={`${tiles.open.count} booking${tiles.open.count === 1 ? '' : 's'}${tiles.open.unpriced ? ` · ${tiles.open.unpriced} missing a quote` : ''}`}
            active={!quick && filterStatus === 'HOLD'}
            onClick={() => { setQuick(null); setFilterStatus('HOLD') }}
          />
          <SummaryTile
            title={`Expiring within ${EXPIRING_SOON_HOURS} hours`}
            value={fmtMoney(tiles.expiring.value)}
            detail={`${tiles.expiring.count} booking${tiles.expiring.count === 1 ? '' : 's'}`}
            tone={tiles.expiring.count ? 'amber' : undefined}
            active={quick === 'expiring'}
            onClick={() => setQuick(q => (q === 'expiring' ? null : 'expiring'))}
          />
          <SummaryTile
            title="Committed (won)"
            value={fmtMoney(tiles.won.value)}
            detail={`${tiles.won.count} booking${tiles.won.count === 1 ? '' : 's'}${tiles.won.ledUnlinked ? ` · ${tiles.won.ledUnlinked} not linked to an LED client` : ''}`}
            onClick={() => { setQuick(null); setFilterStatus('HOLD') }}
          />
          <SummaryTile
            title="Needs attention"
            value={String(tiles.attention.count)}
            detail={(Object.entries(tiles.attention.byKind) as [keyof typeof ATTENTION_LABEL, number][])
              .map(([k, n]) => `${n} ${ATTENTION_LABEL[k].toLowerCase()}`).join(' · ') || 'Nothing flagged'}
            tone={tiles.attention.count ? 'red' : undefined}
            active={quick === 'attention'}
            onClick={() => setQuick(q => (q === 'attention' ? null : 'attention'))}
          />
        </div>

        {/* Status tabs, with how many bookings each lists */}
        <div className="flex flex-wrap items-end gap-x-1 gap-y-1 border-b border-gray-200 mb-4">
          {TABS.map((s) => (
            <button
              key={s}
              onClick={() => { setQuick(null); setFilterStatus(s) }}
              className={`px-3 py-2 -mb-px text-sm font-medium border-b-2 transition-colors ${
                !quick && filterStatus === s
                  ? 'border-green-600 text-gray-900'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              {TAB_LABEL[s] ?? STATUS_LABEL[s] ?? s} <span className="text-gray-400">({tabCounts.get(s) ?? 0})</span>
              {s === 'HOLD' && extensionRequests > 0 && (
                <span className="ml-1.5 inline-flex items-center px-1.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800" title="Bookings with a client extension request waiting">
                  {extensionRequests} extension request{extensionRequests === 1 ? '' : 's'}
                </span>
              )}
            </button>
          ))}
        </div>
        {quick && (
          <div className="mb-4 flex items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gray-900 text-white text-xs font-medium">
              {quick === 'expiring' ? `Expiring within ${EXPIRING_SOON_HOURS} hours` : 'Needs attention'}, every tab
              <button onClick={() => setQuick(null)} aria-label="Clear" className="text-gray-300 hover:text-white">✕</button>
            </span>
          </div>
        )}

        {/* Also shown when "Take off list" is clicked on a soft hold under another filter. */}
        {(filterStatus === 'ATT_SOFT' || rosterDraft) && (
          <AttRosterPanel draft={rosterDraft} setDraft={setRosterDraft} onChanged={fetchRequests} />
        )}

        {/* Search, dates and sort */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative flex-1 min-w-[14rem] max-w-md">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 104.35 4.35a7.5 7.5 0 0012.3 12.3z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by client, truck, market, or notes…"
              className="w-full border border-gray-200 rounded-lg pl-9 pr-8 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
            {search && (
              <button onClick={() => setSearch('')} aria-label="Clear search" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                ✕
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-sm text-gray-600 flex-wrap">
            <span>Running</span>
            <input type="date" value={dateFrom} onChange={(e) => chooseFrom(e.target.value)} aria-label="Running from"
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
            <span>to</span>
            <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => chooseTo(e.target.value)} aria-label="Running to"
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
            {(dateFrom || dateTo) && (
              <button onClick={() => { setDateFrom(''); setDateTo('') }} aria-label="Clear dates" className="text-gray-400 hover:text-gray-600 px-1">✕</button>
            )}
          </div>
          <SortSelect columns={SORT_COLUMNS} sort={sort} onChange={chooseSort} defaultLabel="Newest first" />
        </div>

        {loading ? (
          <TableSkeleton />
        ) : sortedBookings.length === 0 ? (
          <div className="text-center py-20 text-gray-400">
            <p className="font-medium text-gray-500">No hold requests found</p>
            <p className="text-sm mt-1">
              {search || filterStatus || quick || ownerShown !== 'all' || dateFrom || dateTo ? 'Try a different search term or filter' : 'Requests submitted by clients will show up here'}
            </p>
          </div>
        ) : (
          <>
            {/* Wide screens: one row per booking, opened for its detail. */}
            <div className="hidden md:block bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <table className="w-full text-sm table-fixed">
                <thead className="bg-gray-50/80 border-b border-gray-200">
                  <tr>
                    <th className="w-8" aria-label="Open" />
                    <SortableTh label="Client" sortKey="client" sort={sort} onSort={sortBy} className={`${TH_CELL} w-[22%]`} />
                    <SortableTh label="Markets" sortKey="market" sort={sort} onSort={sortBy} className={`${TH_CELL} w-[20%]`} />
                    <SortableTh label="Trucks" sortKey="truck" sort={sort} onSort={sortBy} className={`${TH_CELL} w-[7%]`} />
                    <SortableTh label="Dates" sortKey="dates" sort={sort} onSort={sortBy} className={`${TH_CELL} w-[14%]`} />
                    <SortableTh label="Pricing" sortKey="pricing" sort={sort} onSort={sortBy} className={`${TH_CELL} w-[12%]`} />
                    <SortableTh label="Status" sortKey="status" sort={sort} onSort={sortBy} className={`${TH_CELL} w-[12%]`} />
                    <SortableTh label="Expires" sortKey="expires" sort={sort} onSort={sortBy} className={TH_CELL} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sortedBookings.map(({ key: groupKey, rows }) => {
                    const v = bookingView(rows)
                    const open = expanded.has(groupKey)
                    return (
                      <Fragment key={groupKey}>
                        <tr onClick={() => toggle(groupKey)} className={`cursor-pointer align-top transition-colors ${open ? 'bg-green-50/40' : 'hover:bg-gray-50/60'}`}>
                          <td className="pl-3 py-3">
                            <button aria-expanded={open} aria-label={open ? 'Close details' : 'Open details'} onClick={(e) => { e.stopPropagation(); toggle(groupKey) }}
                              className="text-gray-400 hover:text-gray-700">
                              <svg className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`} viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.17 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" /></svg>
                            </button>
                          </td>
                          <td className="px-3 py-3 min-w-0">
                            <div className="font-semibold text-gray-900 break-words">{v.first.company_name}</div>
                            <div className="text-xs text-gray-500 break-words">{v.first.owner_name || '—'} · {SOURCE_LABEL[v.first.source] ?? v.first.source}</div>
                          </td>
                          <td className="px-3 py-3 text-gray-700 break-words">{v.marketsLabel}</td>
                          <td className="px-3 py-3 font-semibold text-gray-900">{v.trucks}</td>
                          <td className="px-3 py-3 text-gray-700">{v.datesLabel}</td>
                          <td className="px-3 py-3"><BookingPrice v={v} /></td>
                          <td className="px-3 py-3"><StatusPill v={v} /></td>
                          <td className="px-3 py-3"><ExpiryCell v={v} /></td>
                        </tr>
                        {open && (
                          <tr className="bg-green-50/40">
                            <td colSpan={8} className="px-4 pb-4 pt-1">{renderDetail(groupKey, rows, v)}</td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Phones: a card per booking, opened the same way. */}
            <div className="md:hidden space-y-3">
              {sortedBookings.map(({ key: groupKey, rows }) => {
                const v = bookingView(rows)
                const open = expanded.has(groupKey)
                return (
                  <div key={groupKey} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                    <button onClick={() => toggle(groupKey)} aria-expanded={open} className="w-full text-left px-4 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-semibold text-gray-900 break-words">{v.first.company_name}</div>
                          <div className="text-xs text-gray-500 break-words">{v.first.owner_name || '—'} · {SOURCE_LABEL[v.first.source] ?? v.first.source}</div>
                        </div>
                        <StatusPill v={v} />
                      </div>
                      <div className="mt-2 text-sm text-gray-700 break-words">{v.marketsLabel}</div>
                      <div className="mt-1 flex items-center justify-between gap-2 flex-wrap text-xs text-gray-600">
                        <span>{v.trucks} truck{v.trucks === 1 ? '' : 's'} · {v.datesLabel}</span>
                        <BookingPrice v={v} />
                      </div>
                      <div className="mt-1"><ExpiryCell v={v} /></div>
                    </button>
                    {open && <div className="px-3 pb-3">{renderDetail(groupKey, rows, v)}</div>}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {/* Edit / Cancel Modal */}
      {editingGroup && editingGroup.length > 0 && (() => {
        const first = editingGroup[0]
        // A won deal: truck swaps only (lib/bookings.ts closedWonRefusal).
        const won = !!closedWonRefusal(editingGroup)
        // A client's request waiting: its expiry changes only by Approve or Deny (lib/expiryRules.ts).
        const requested = editingGroup.some(r => r.status === 'EXTENSION_REQUESTED')
        const currentExpDate = first.expires_at ? centralDate(new Date(first.expires_at)) : ''
        const hasChanges = editingGroup.some(r => selectedTrucks.get(r.id) !== r.truck_number) || (!won && !requested && newExpiresAt !== currentExpDate)
        return (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
              <div className="px-6 py-4 border-b border-gray-100">
                <h2 className="text-lg font-bold text-gray-900">Edit Reservation</h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  {(() => {
                    const b = summarizeBooking(editingGroup)
                    return (
                      <>
                        {first.company_name} &middot; {b.markets.length > 1 ? `${b.markets.length} markets` : formatMarketState(first.market, first.state)} &middot;{' '}
                        {format(parseDateOnly(b.start), 'MMM d')} &ndash; {format(parseDateOnly(b.end), 'MMM d, yyyy')}
                        {editingGroup.length > 1 && <span className="ml-1">({b.trucks} trucks)</span>}
                      </>
                    )
                  })()}
                </p>
              </div>
              <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1">
                {!cancelMode ? (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        {editingGroup.length > 1 ? 'Assigned Trucks' : 'Assigned Truck'}
                      </label>
                      {trucksLoading ? (
                        <p className="text-xs text-gray-400">Loading available trucks...</p>
                      ) : (
                        <div className="space-y-3">
                          {editingGroup.map((r) => {
                            const available = availableTrucksMap.get(r.id) ?? []
                            return (
                              <div key={r.id}>
                                {editingGroup.length > 1 && (
                                  <div className="text-xs text-gray-500 mb-1">Truck {r.truck_number} &middot; {formatMarketState(r.market, r.state)}</div>
                                )}
                                {available.length > 1 ? (
                                  <>
                                  <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-72 overflow-y-auto bg-white">
                                    {available.map(t => {
                                      const chosen = (selectedTrucks.get(r.id) ?? r.truck_number) === t.truckNumber
                                      return (
                                        <label
                                          key={t.truckNumber}
                                          className={`flex items-start gap-3 px-3 py-2.5 cursor-pointer transition-colors ${chosen ? 'bg-green-50' : 'hover:bg-gray-50'}`}
                                        >
                                          <input
                                            type="radio"
                                            name={`truck-${r.id}`}
                                            value={t.truckNumber}
                                            checked={chosen}
                                            onChange={() => setSelectedTrucks(prev => new Map(prev).set(r.id, t.truckNumber))}
                                            className="mt-1 accent-green-600"
                                          />
                                          <span className="flex-1 min-w-0">
                                            <span className="flex items-center gap-1.5 flex-wrap">
                                              <span className="text-sm font-semibold text-gray-900">{t.truckNumber}</span>
                                              {t.current && (
                                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-200 text-gray-700">CURRENT</span>
                                              )}
                                              {t.needsTransport ? (
                                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                                                  TRANSPORT {t.transportDays}d · {fmtMoney(t.transportCharge)}
                                                </span>
                                              ) : (
                                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-green-100 text-green-800" title={`Within the ${SERVICE_AREA_RADIUS_MILES}-mile service area: no transport charge`}>
                                                  {t.distanceMiles <= 50 ? 'LOCAL' : 'NO TRANSPORT'}
                                                </span>
                                              )}
                                              {t.requiresOverride && (
                                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-purple-100 text-purple-800">NEEDS SOFT-HOLD RELEASE</span>
                                              )}
                                            </span>
                                            <span className="block text-xs text-gray-500 mt-0.5">
                                              Departs {t.departsFrom}
                                              {t.distanceMiles > 0 && ` · ${Math.round(t.distanceMiles)} mi out`}
                                              {t.originIsCommitment
                                                ? ' · from its prior booking'
                                                : ' · current GPS position'}
                                            </span>
                                            {t.softHoldWarning && (
                                              <span className="block text-[11px] text-amber-700">{t.softHoldWarning}</span>
                                            )}
                                            {t.originIsCommitment && t.gpsMarket && (
                                              <span className="block text-[11px] text-gray-400">
                                                (parked in {t.gpsMarket} today)
                                              </span>
                                            )}
                                          </span>
                                        </label>
                                      )
                                    })}
                                  </div>
                                  <p className="text-[11px] text-gray-400 mt-1.5">
                                    Distance and transport are measured from where each truck will actually be when this campaign starts.
                                  </p>
                                  </>
                                ) : (
                                  <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-3 py-2.5">
                                    {r.truck_number}
                                    <span className="text-xs text-gray-400 ml-2">(no alternatives available)</span>
                                  </p>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                    {first.pricing_tier && (
                      <div className="bg-gray-50 rounded-lg px-3 py-2.5">
                        {/* A multi-market booking: the whole reservation's price, as on its card. */}
                        {isMultiMarket(first) ? (() => {
                          const b = summarizeBooking(editingGroup, (bookingKey(first) ? rowsByBooking.get(bookingKey(first)!) : undefined) ?? editingGroup)
                          return (
                            <>
                              <PricingBadge tier={b.tier} total={b.total} />
                              {(b.unpricedMarkets > 0 || b.splitMarkets > 0) && (
                                <span className="ml-2 text-xs text-amber-700">
                                  {[b.unpricedMarkets > 0 ? `${b.unpricedMarkets} unpriced` : '', b.splitMarkets > 0 ? `${b.splitMarkets} split` : ''].filter(Boolean).join(', ')} not in this total
                                </span>
                              )}
                            </>
                          )
                        })() : <PricingBadge tier={first.pricing_tier} total={first.quoted_total} />}
                      </div>
                    )}

                    {/* Expiration management — none on a won deal: it is booked, not held */}
                    {won ? (
                      <p className="text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2.5">{CLOSED_WON_READ_ONLY} Only a truck swap can be made here.</p>
                    ) : (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Expiration Date</label>
                      {first.expires_at ? (
                        <input
                          type="date"
                          value={newExpiresAt}
                          min={centralDate(new Date())}
                          max={editLastDate || undefined}
                          disabled={requested}
                          onChange={(e) => { setNewExpiresAt(e.target.value); setExpiryEdited(true) }}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                        />
                      ) : null}
                      {requested && (
                        <p className="mt-1.5 text-xs text-gray-500">The client has asked to extend this reservation: approve or deny the request to change its expiry.</p>
                      )}
                      {first.expires_at && editLastDate && !requested && (
                        <p className={`mt-1.5 text-xs ${expiryEdited && newExpiresAt > editLastDate ? 'text-red-700 font-medium' : 'text-gray-500'}`}>
                          {expiryEdited && newExpiresAt > editLastDate ? 'Too late: ' : ''}
                          Held until {format(parseDateOnly(editLastDate), 'MMM d')} at the latest ({STAFF_MIN_DAYS_BEFORE_START} days before the first market starts). Every truck on this card gets the same date.
                        </p>
                      )}
                      {!first.expires_at && (
                        <div className="flex items-center gap-2">
                          <p className="text-sm text-gray-500">No expiration set</p>
                          <button
                            type="button"
                            onClick={() => {
                              setNewExpiresAt(centralDate(new Date(Date.now() + 3 * 864e5)))
                              setExpiryEdited(true)
                            }}
                            className="text-xs text-green-600 hover:text-green-700 font-medium transition-colors"
                          >
                            + Add expiration
                          </button>
                        </div>
                      )}
                      {first.status === 'EXTENSION_REQUESTED' && first.extension_reason && (
                        <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
                          <p className="text-xs font-medium text-amber-800">Extension requested</p>
                          <p className="text-xs text-amber-700 mt-0.5">{first.extension_reason}</p>
                        </div>
                      )}
                    </div>
                    )}
                  </>
                ) : (
                  <div className="space-y-3">
                    <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                      <p className="text-sm font-medium text-red-800">
                        Cancel this reservation{editingGroup.length > 1 ? ` (${editingGroup.length} trucks)` : ''}?
                      </p>
                      <p className="text-xs text-red-600 mt-1">
                        {editingGroup.map(r => r.truck_number).join(', ')} &middot; {[...new Set(editingGroup.map(r => r.market))].join(', ')} &middot;{' '}
                        {(({ start, end }) => `${start} to ${end}`)(summarizeBooking(editingGroup))}
                      </p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Reason / Note to client</label>
                      <textarea
                        value={cancelReason}
                        onChange={(e) => setCancelReason(e.target.value)}
                        maxLength={CANCEL_REASON_MAX}
                        rows={3}
                        placeholder="e.g. Truck reassigned due to maintenance scheduling..."
                        className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent resize-none"
                      />
                    </div>
                    <p className="text-xs text-gray-500">
                      {editingGroup.some(r => r.client_emailable)
                        ? 'The client is emailed this reason, and sees it on the cancelled reservation in their portal.'
                        : editingGroup.some(r => r.client_portal)
                          ? 'No client email on file: the client is not emailed, but sees this reason on the cancelled reservation in their portal.'
                          : 'No client account on this reservation: the reason is kept on it here only.'}
                    </p>
                  </div>
                )}
              </div>
              <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
                {!cancelMode ? (
                  <>
                    <button
                      onClick={() => setEditingGroup(null)}
                      className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2.5 text-sm font-medium hover:bg-gray-50 transition-colors"
                    >
                      Close
                    </button>
                    {!won && (
                      <button
                        onClick={() => setCancelMode(true)}
                        className="flex-1 border border-red-200 text-red-600 rounded-lg py-2.5 text-sm font-medium hover:bg-red-50 transition-colors"
                      >
                        Cancel & Notify
                      </button>
                    )}
                    <button
                      onClick={handleSaveEdits}
                      disabled={saving || !hasChanges}
                      className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
                    >
                      {saving ? 'Saving...' : hasChanges ? 'Save Changes' : 'No Changes'}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => setCancelMode(false)}
                      className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2.5 text-sm font-medium hover:bg-gray-50 transition-colors"
                    >
                      Back
                    </button>
                    <button
                      onClick={handleCancelNotify}
                      disabled={saving || !cancelReason.trim()}
                      className="flex-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
                    >
                      {saving ? 'Cancelling...' : 'Confirm Cancellation'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Release an AT&T soft hold for a booking's dates */}
      {softRelease && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-lg font-bold text-gray-900">Release AT&amp;T soft hold</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                Truck {softRelease.hold.truck_number} &middot; held for AT&amp;T{' '}
                {format(parseDateOnly(softRelease.hold.start_date), 'MMM d')} &ndash; {format(parseDateOnly(softRelease.hold.end_date), 'MMM d, yyyy')}
              </p>
            </div>
            <div className="px-6 py-4 space-y-3">
              <p className="text-xs text-purple-800 bg-purple-50 border border-purple-200 rounded-lg px-3 py-2">{ATT_RELEASE_WARNING}</p>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-medium text-gray-600">
                  Booking starts
                  <input type="date" value={softRelease.start}
                    min={softRelease.hold.start_date} max={softRelease.hold.end_date}
                    onChange={e => setSoftRelease({ ...softRelease, start: e.target.value, end: softRelease.end || e.target.value })}
                    className="mt-1 w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
                </label>
                <label className="text-xs font-medium text-gray-600">
                  Booking ends
                  <input type="date" value={softRelease.end}
                    min={softRelease.start || softRelease.hold.start_date} max={softRelease.hold.end_date}
                    onChange={e => setSoftRelease({ ...softRelease, end: e.target.value })}
                    className="mt-1 w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
                </label>
              </div>
              <label className="block text-xs font-medium text-gray-600">
                Which booking is this for?
                <input type="text" value={softRelease.context} maxLength={150}
                  placeholder="e.g. Acme, Dallas"
                  onChange={e => setSoftRelease({ ...softRelease, context: e.target.value })}
                  className="mt-1 w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
              </label>
              <p className="text-xs text-gray-500">
                Only these dates are released (at most {ATT_RELEASE_MAX_DAYS} days); the rest stays reserved for AT&amp;T. Undo it from the Conflicts page.
              </p>
              {softReleaseError && softRelease.start && <p className="text-xs text-red-600">{softReleaseError}</p>}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
              <button onClick={() => setSoftRelease(null)}
                className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2.5 text-sm font-medium hover:bg-gray-50 transition-colors">
                Cancel
              </button>
              <button onClick={submitSoftRelease} disabled={saving || Boolean(softReleaseError)}
                className="flex-1 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors">
                {saving ? 'Releasing...' : 'Release these dates'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The booking's Salesforce opportunity (one per booking; a legacy booking with
 * several lists each) and its account, opening in a new tab. Staff only: this
 * page is behind the staff sign-in.
 */
function SalesforceLinks({ base, rows }: { base: string | null; rows: { sfdc_opportunity_id: string | null; sfdc_account_id: string | null }[] }) {
  const opps = [...new Set(rows.map(r => r.sfdc_opportunity_id).filter((id): id is string => !!id))]
    .flatMap(id => { const url = opportunityUrl(base, id); return url ? [url] : [] })
  const account = accountUrl(base, rows.find(r => r.sfdc_account_id)?.sfdc_account_id)
  if (!opps.length && !account) return null
  const link = 'text-xs text-blue-700 hover:underline'
  return (
    <span className="flex items-center gap-2">
      {opps.map((url, i) => (
        <a key={url} href={url} target="_blank" rel="noopener noreferrer" className={link}>
          {opps.length === 1 ? 'Opportunity' : `Opportunity ${i + 1}`} ↗
        </a>
      ))}
      {account && <a href={account} target="_blank" rel="noopener noreferrer" className={link}>Account ↗</a>}
    </span>
  )
}

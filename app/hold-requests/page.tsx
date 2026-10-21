'use client'

import { ATT_RELEASE_WARNING, ATT_RELEASE_MAX_DAYS, validateReleaseRange } from '@/lib/attSoftRules'
import { QUOTE_ONLY_ORIGINATION } from '@/lib/quoteOnly'
import { SERVICE_AREA_RADIUS_MILES } from '@/lib/pricing/config'
import { Fragment, useState, useEffect, useCallback, useMemo } from 'react'
import { format, formatDistanceToNow, isPast } from 'date-fns'
import toast from 'react-hot-toast'
import { Navbar } from '@/components/Navbar'
import { TableSkeleton } from '@/components/LoadingSkeleton'
import { centralDate, parseDateOnly } from '@/lib/dateOnly'
import { useReopenConfirm, type Reopenable } from '@/components/ReopenOpportunityDialog'
import { formatMarketState } from '@/lib/format'
import { parseQuoteFeatures, QuoteBreakdown } from '@/components/QuoteBreakdown'
import { AttRosterPanel, newAddDraft, type RosterDraft } from '@/components/AttRosterPanel'
import { SortableTh, SortSelect, useTableSort } from '@/components/SortableTh'
import { minValue, sortRows, type SortValue } from '@/lib/tableSort'
import { CLOSED_WON_READ_ONLY, bookingCapStarts, bookingKey, closedWonRefusal, bookingStatus, earliestExpiryDate, expiryEdits, isMultiMarket, marketGroups, summarizeBooking } from '@/lib/bookings'
import { STAFF_MIN_DAYS_BEFORE_START, lastExpiryDate } from '@/lib/holdExpiry'

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
  pricing_tier: string | null
  quoted_total: number | null
  daily_rate: number | null
  features: string | null
  truck_count: number | null
  campaign_group_id: string | null
  sfdc_opportunity_id: string | null
  expires_at: string | null
  extension_reason: string | null
  extension_until: string | null
  created_at: string
}

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
}

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
  return (
    <a href={`/quote?revise=${encodeURIComponent(key)}`}
      title="Add, drop or change markets and dates on the same opportunity"
      className="px-3 py-1.5 rounded-lg text-xs font-medium border border-blue-200 text-blue-700 hover:bg-blue-50 transition-colors">
      Revise
    </a>
  )
}

function ExpirationBadge({ expiresAt, status }: { expiresAt: string | null; status: string }) {
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
      const send = async (reopenOpportunity = false): Promise<{ ok: boolean; error?: string; reopenable?: Reopenable; holds?: number; sfdcWarning?: string | null }> => {
        const res = await fetch(`/api/hold-requests/${allIds[0]}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ action, ...(reopenOpportunity ? { reopenOpportunity: true } : {}) }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) return { ok: false, error: body.error || 'Failed', reopenable: body.reopenable }
        return { ok: true, holds: body.holds, sfdcWarning: body.sfdcWarning ?? null }
      }
      let result = await send()
      // Reinstating onto a Closed Lost opportunity: ask once, then send it again.
      if (result.reopenable && await reopen.ask(result.reopenable.question)) result = await send(true)

      const actionLabel = action.replace('_', ' ')
      if (result.ok) {
        // A reinstated hold is no longer EXPIRED, so it leaves whichever expired view the
        // button was clicked from. Follow it to Active rather than letting the row vanish.
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

  const filtered = useMemo(
    () => {
      // A filter picks whole bookings by the booking's status, never part of one.
      const shown = (status: string) => !filterStatus
        || (filterStatus === 'HOLD' ? status === 'HOLD' || status === 'COMMITTED' : status === filterStatus)
      let result = requests.filter(r => shown(statusOf(r).status))
      const q = search.trim().toLowerCase()
      if (q) {
        const matches = (r: HoldRequest) => [r.company_name, r.truck_number, r.market, r.notes]
          .filter(Boolean)
          .some((field) => field!.toLowerCase().includes(q))
        // A match shows its whole booking, so a card, its total and its Edit
        // always cover the same reservations.
        const cards = new Set(result.filter(matches).map(r => bookingKey(r)).filter(Boolean))
        result = result.filter((r) => { const k = bookingKey(r); return k ? cards.has(k) : matches(r) })
      }
      return result
    },
    [requests, filterStatus, search, statusOf]
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

  // Group by booking (lib/bookings.ts) so multi-truck and multi-market
  // reservations are reviewed and managed as one unit: every market of a
  // multi-market quote, a campaign group, or a Salesforce opportunity. Then the chosen sort orders the table
  // rows, the campaign cards, and the trucks within each card; with none
  // chosen, the API's order (newest first) stands. Memoized with the filter
  // above, so typing in a dialog does not regroup and re-sort the list.
  const { sortedGroups, sortedUngrouped } = useMemo(() => {
    const grouped = new Map<string, HoldRequest[]>()
    const ungrouped: HoldRequest[] = []
    for (const r of filtered) {
      // One card per booking (lib/bookings.ts bookingKey): a booking is one
      // quote, so its totals, expiry, status and actions cover all of it.
      const groupKey = bookingKey(r)
      if (groupKey) {
        const group = grouped.get(groupKey) ?? []
        group.push(r)
        grouped.set(groupKey, group)
      } else {
        ungrouped.push(r)
      }
    }
    // Single-item "groups" aren't really groups — move them to ungrouped
    for (const [key, items] of grouped) {
      if (items.length === 1) {
        ungrouped.push(items[0])
        grouped.delete(key)
      }
    }
    return {
      sortedUngrouped: sortRows(ungrouped, sort, sortValue),
      sortedGroups: sortRows(
        Array.from(grouped.entries()).map(([id, rows]) => [id, sortRows(rows, sort, sortValue)] as const),
        sort,
        ([, rows], key) => groupSortValue([...rows], key),
      ),
    }
  }, [filtered, sort])

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
      if (quoteOnly) {
        return <span className="text-xs text-gray-400" title="Re-quote to reserve trucks">Quote only</span>
      }
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

  return (
    <div className="flex flex-col min-h-dvh bg-gray-50">
      <Navbar />
      {reopen.dialog}

      <div className="flex-1 p-4 sm:p-6 max-w-7xl mx-auto w-full">
        {/* Header */}
        <div className="flex items-start sm:items-center justify-between mb-6 gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Reservations</h1>
            <p className="text-sm text-gray-500 mt-0.5">All hold requests and reservations — edit, cancel, or manage extensions</p>
            {expiredWindowDays !== null && (filterStatus === '' || filterStatus === 'EXPIRED') && (
              <p className="text-xs text-gray-400 mt-1">
                Showing expired reservations from the last {expiredWindowDays} days. Older ones are kept but not listed here.
              </p>
            )}
          </div>
          <div className="flex gap-2 flex-shrink-0 flex-wrap">
            {(['', 'HOLD', 'ATT_SOFT', 'EXTENSION_REQUESTED', 'EXPIRED'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilterStatus(s)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                  filterStatus === s
                    ? 'bg-green-600 text-white border-green-600'
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                }`}
              >
                {s ? (STATUS_LABEL[s] ?? s) : 'All'}
              </button>
            ))}
          </div>
        </div>

        {/* Also shown when "Take off list" is clicked on a soft hold under another filter. */}
        {(filterStatus === 'ATT_SOFT' || rosterDraft) && (
          <AttRosterPanel draft={rosterDraft} setDraft={setRosterDraft} onChanged={fetchRequests} />
        )}

        {/* Search and sort */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="relative flex-1 min-w-[16rem] max-w-md">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 104.35 4.35a7.5 7.5 0 0012.3 12.3z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by client, truck, market, or notes…"
            className="w-full border border-gray-200 rounded-lg pl-9 pr-8 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
          {search && (
            <button onClick={() => setSearch('')} aria-label="Clear search" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              ✕
            </button>
          )}
        </div>
        <SortSelect columns={SORT_COLUMNS} sort={sort} onChange={chooseSort} defaultLabel="Newest first" />
        </div>

        {loading ? (
          <TableSkeleton />
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-gray-400">
            <p className="font-medium text-gray-500">No hold requests found</p>
            <p className="text-sm mt-1">
              {search || filterStatus ? 'Try a different search term or filter' : 'Requests submitted by clients will show up here'}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Campaign groups — one card per campaign, actions apply to every truck in it */}
            {sortedGroups.map(([groupId, groupItems]) => {
              // The booking's one status; `odd` is only ever set for a booking made
              // before the one-expiry rule (#118) whose markets lapsed apart.
              const { status, odd } = bookingStatus(groupItems)
              // The row the card speaks for: one in the booking's status.
              const first = groupItems.find(g => g.status === status) ?? groupItems[0]
              // What the card's actions act on: its holds in the booking's status.
              const ids = groupItems.filter(g => g.status === status).map((g) => g.id)
              // A multi-market booking: one card, its figures summed across markets.
              const multi = isMultiMarket(first)
              const booking = summarizeBooking(groupItems)
              // The expiry to act on: the booking's live holds'.
              const expiry = summarizeBooking(groupItems.filter(g => g.status === status)).earliestExpiry
              const key = bookingKey(first)
              return (
                <div key={groupId} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="px-4 py-3 bg-gray-50/80 border-b border-gray-200 flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900">
                        {multi
                          ? <>{first.company_name} — {booking.trucks} truck{booking.trucks === 1 ? '' : 's'} across {booking.markets.length} market{booking.markets.length === 1 ? '' : 's'}</>
                          : <>{first.company_name} — {first.truck_count ?? groupItems.length} truck{(first.truck_count ?? groupItems.length) === 1 ? '' : 's'} · {formatMarketState(first.market, first.state)}</>}
                      </span>
                      <span className="text-xs text-gray-500">
                        {format(parseDateOnly(booking.start), 'MMM d')} &ndash; {format(parseDateOnly(booking.end), 'MMM d, yyyy')}
                      </span>
                      {first.created_by_name && (
                        <span className="text-xs text-gray-400">by {first.created_by_name}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${SOURCE_BADGE[first.source] ?? SOURCE_BADGE.INTERNAL}`}>
                        {SOURCE_LABEL[first.source] ?? first.source}
                      </span>
                      <PricingBadge tier={multi ? booking.tier : first.pricing_tier} total={multi ? booking.total : first.quoted_total} />
                      {multi && booking.unpricedMarkets > 0 && (
                        <span className="text-xs text-amber-700" title="These markets have no price on file; the total above leaves them out">
                          + {booking.unpricedMarkets} unpriced
                        </span>
                      )}
                      {/* The earliest expiry in the booking is the one to act on. */}
                      <ExpirationBadge expiresAt={expiry} status={status} />
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[status] ?? STATUS_BADGE.HOLD}`}>
                        {first.origination === QUOTE_ONLY_ORIGINATION ? 'Quote only' : (STATUS_LABEL[status] ?? status)}
                      </span>
                    </div>
                  </div>
                  {odd.length > 0 && (
                    // Only an older booking (before #118) can be split; the card stays whole.
                    <div className="px-4 py-1.5 text-xs text-amber-800 bg-amber-50 border-b border-amber-100">
                      Older booking with markets out of step:{' '}
                      {odd.map(o => `${o.markets.join(', ')} ${STATUS_LABEL[o.status] ?? o.status}`).join('; ')}.
                      {' '}Actions here apply to the {STATUS_LABEL[status] ?? status} markets.
                    </div>
                  )}
                  {(() => {
                    // One market's breakdown would misstate a multi-market booking.
                    const parsedFeatures = multi ? null : parseQuoteFeatures(first.features)
                    return parsedFeatures ? (
                      <div className="px-4 py-3 bg-white border-b border-gray-100">
                        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Quote breakdown</div>
                        <QuoteBreakdown features={parsedFeatures} />
                      </div>
                    ) : null
                  })()}
                  {multi ? (
                    // Each market as its own subgroup, in flight order: its dates and length, then its trucks.
                    // The same rows as the card's totals and actions (groupItems), only arranged.
                    <div className="divide-y divide-gray-100">
                      {marketGroups(groupItems).map((m) => (
                        <div key={m.key}>
                          <div className="px-4 py-2 bg-gray-50 flex items-center justify-between text-sm">
                            <span className="font-semibold text-gray-900">{formatMarketState(m.market, m.rows[0].state)}</span>
                            <span className="text-xs text-gray-600">
                              {format(parseDateOnly(m.start), 'MMM d')} &ndash; {format(parseDateOnly(m.end), 'MMM d, yyyy')}
                              {' · '}{m.days} {m.daysKind === 'activation' ? 'activation' : 'calendar'} day{m.days === 1 ? '' : 's'}
                            </span>
                          </div>
                          {m.rows.map((r) => (
                            <div key={r.id} className="pl-8 pr-4 py-2 flex items-center justify-between text-sm">
                              <span className="font-medium text-gray-900">Truck {r.truck_number}</span>
                              {/* A truck's own dates, when it covers only part of the market's (alternating trucks). */}
                              {(r.start_date.slice(0, 10) !== m.start || r.end_date.slice(0, 10) !== m.end) && (
                                <span className="text-xs text-gray-500">{format(parseDateOnly(r.start_date), 'MMM d')} &ndash; {format(parseDateOnly(r.end_date), 'MMM d')}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="divide-y divide-gray-100">
                      {groupItems.map((r) => (
                        <div key={r.id} className="px-4 py-2.5 flex items-center justify-between text-sm">
                          <span className="font-medium text-gray-900">Truck {r.truck_number}</span>
                          <span className="text-gray-500">{formatMarketState(r.market, r.state)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {status === 'EXTENSION_REQUESTED' && (
                    <div className="px-4 py-2 text-xs text-amber-800 bg-amber-50 border-t border-amber-100">
                      Extension requested for the whole booking{first.extension_until ? ` until ${format(parseDateOnly(centralDate(new Date(first.extension_until))), 'MMM d')}` : ''}.
                      {first.extension_reason ? ` Reason: ${first.extension_reason}` : ''}
                    </div>
                  )}
                  {status === 'COMMITTED' && closedWonRefusal(groupItems) && (
                    <div className="px-4 py-1.5 text-xs text-gray-600 bg-gray-50 border-t border-gray-100">
                      Closed Won: only a truck swap can be made here. Change anything else in Salesforce.
                    </div>
                  )}
                  {(status === 'HOLD' || status === 'COMMITTED' || status === 'EXTENSION_REQUESTED' || status === 'EXPIRED') && (
                    <div className="px-4 py-3 border-t border-gray-100 bg-gray-50/80 flex items-center gap-2">
                      {status === 'EXTENSION_REQUESTED' || status === 'EXPIRED' ? (
                        <Actions ids={ids} status={status} groupKey={groupId} quoteOnly={groupItems.some(g => g.origination === QUOTE_ONLY_ORIGINATION)} />
                      ) : (
                        <button
                          onClick={() => openEdit(first)}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                          {closedWonRefusal(groupItems) ? 'Swap trucks' : 'Edit'}
                        </button>
                      )}
                      {status !== 'EXTENSION_REQUESTED' && <ReviseLink rows={groupItems} booking={(key ? rowsByBooking.get(key) : undefined) ?? groupItems} />}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Ungrouped (single-truck requests without a campaign group, or legacy rows) */}
            {sortedUngrouped.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50/80 border-b border-gray-200">
                      <tr>
                        {SORT_COLUMNS.map((c) => (
                          <SortableTh key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={sortBy} />
                        ))}
                        <SortableTh label="Actions" sort={sort} onSort={sortBy} />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {sortedUngrouped.map((r) => {
                        const parsedFeatures = parseQuoteFeatures(r.features)
                        return (
                          <Fragment key={r.id}>
                            <tr className="hover:bg-gray-50/60 transition-colors">
                              <td className="px-4 py-3 font-semibold text-gray-900">{r.truck_number}</td>
                              <td className="px-4 py-3 text-gray-600">{r.company_name}</td>
                              <td className="px-4 py-3 text-gray-600">{formatMarketState(r.market, r.state)}</td>
                              <td className="px-4 py-3 text-gray-600">
                                {format(parseDateOnly(r.start_date), 'MMM d')} &ndash; {format(parseDateOnly(r.end_date), 'MMM d')}
                              </td>
                              <td className="px-4 py-3">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${SOURCE_BADGE[r.source] ?? SOURCE_BADGE.INTERNAL}`}>
                                  {SOURCE_LABEL[r.source] ?? r.source}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-gray-500 text-xs">{r.created_by_name || '—'}</td>
                              <td className="px-4 py-3">
                                <PricingBadge tier={r.pricing_tier} total={r.quoted_total} />
                              </td>
                              <td className="px-4 py-3">
                                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[r.status] ?? STATUS_BADGE.HOLD}`}>
                                  {r.origination === QUOTE_ONLY_ORIGINATION ? 'Quote only' : (STATUS_LABEL[r.status] ?? r.status)}
                                </span>
                              </td>
                              <td className="px-4 py-3">
                                <ExpirationBadge expiresAt={r.expires_at} status={r.status} />
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <Actions ids={[r.id]} status={r.status} groupKey={r.id} requests={[r]} quoteOnly={r.origination === QUOTE_ONLY_ORIGINATION} />
                                  {['HOLD', 'COMMITTED', 'EXPIRED'].includes(r.status) && <ReviseLink rows={[r]} booking={(bookingKey(r) ? rowsByBooking.get(bookingKey(r)!) : undefined) ?? [r]} />}
                                </div>
                              </td>
                            </tr>
                            {parsedFeatures && (
                              <tr className="bg-gray-50/50">
                                <td colSpan={10} className="px-4 pb-3 pt-0">
                                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Quote breakdown</div>
                                  <QuoteBreakdown features={parsedFeatures} />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Edit / Cancel Modal */}
      {editingGroup && editingGroup.length > 0 && (() => {
        const first = editingGroup[0]
        // A won deal: truck swaps only (lib/bookings.ts closedWonRefusal).
        const won = !!closedWonRefusal(editingGroup)
        const currentExpDate = first.expires_at ? centralDate(new Date(first.expires_at)) : ''
        const hasChanges = editingGroup.some(r => selectedTrucks.get(r.id) !== r.truck_number) || (!won && newExpiresAt !== currentExpDate)
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
                          max={editLastDate || undefined}
                          onChange={(e) => { setNewExpiresAt(e.target.value); setExpiryEdited(true) }}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                        />
                      ) : null}
                      {first.expires_at && editLastDate && (
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
                        rows={3}
                        placeholder="e.g. Truck reassigned due to maintenance scheduling..."
                        className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent resize-none"
                      />
                    </div>
                    <p className="text-xs text-gray-500">
                      {first.source === 'CLIENT'
                        ? 'An email will be sent to the client with this reason.'
                        : 'No client email on file — reason will be logged only.'}
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

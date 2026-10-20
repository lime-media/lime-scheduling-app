'use client'

import { Fragment, useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { format, formatDistanceToNow, isPast } from 'date-fns'
import { ClientHeader } from '@/components/ClientHeader'
import { TableSkeleton } from '@/components/LoadingSkeleton'
import { useClientAuth, hasHoldRequestsAccess } from '@/lib/useClientAuth'
import { parseDateOnly } from '@/lib/dateOnly'
import { formatMarketState } from '@/lib/format'
import { parseQuoteFeatures, QuoteBreakdown } from '@/components/QuoteBreakdown'
import { SortableTh, SortSelect, useTableSort } from '@/components/SortableTh'
import { minValue, sortRows, type SortValue } from '@/lib/tableSort'
import { bookingCapStarts, bookingStatus, clientExtendRefusal, marketGroups, summarizeBooking } from '@/lib/bookings'
import { lastExpiryDate } from '@/lib/holdExpiry'

type HoldRequest = {
  id: string
  /** The booking this hold belongs to (an opaque label): a booking is shown and extended as one. */
  booking: string | null
  truck_number: string
  market: string
  state: string
  start_date: string
  end_date: string
  notes: string
  status: string
  company_name: string
  pricing_tier: string | null
  quoted_total: number | null
  daily_rate: number | null
  features: string | null
  truck_count: number | null
  campaign_group_id: string | null
  expires_at: string | null
  extension_until: string | null
  extension_reason: string | null
}

const STATUS_BADGE: Record<string, string> = {
  HOLD:                 'bg-yellow-100 text-yellow-800 border border-yellow-200',
  COMMITTED:            'bg-gray-100 text-gray-700 border border-gray-300',
  EXPIRED:              'bg-gray-100 text-gray-500 border border-gray-200',
  EXTENSION_REQUESTED:  'bg-amber-100 text-amber-800 border border-amber-200',
}

/** The statuses a client's booking can be in, as this page names them. */
const STATUS_LABEL: Record<string, string> = {
  HOLD: 'Reservation',
  EXTENSION_REQUESTED: 'Extension Requested',
  COMMITTED: 'Confirmed',
  EXPIRED: 'Expired',
}

const FILTERS = ['', 'HOLD', 'EXTENSION_REQUESTED', 'COMMITTED', 'EXPIRED'] as const

function fmtMoney(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

function ExpirationBadge({ expiresAt, status }: { expiresAt: string | null; status: string }) {
  // A confirmed booking is booked, not held: it has no expiry to show.
  if (!expiresAt || status === 'COMMITTED') return null
  const expDate = new Date(expiresAt)

  if (status === 'EXPIRED') {
    return (
      <span className="text-xs text-gray-400" title={format(expDate, 'MMM d, yyyy h:mm a')}>
        Expired {format(expDate, 'MMM d')}
      </span>
    )
  }

  if (isPast(expDate)) {
    return (
      <span className="text-xs text-red-500 font-medium" title={format(expDate, 'MMM d, yyyy h:mm a')}>
        Expired {format(expDate, 'MMM d, h:mm a')}
      </span>
    )
  }

  const remaining = formatDistanceToNow(expDate, { addSuffix: false })
  const isUrgent = expDate.getTime() - Date.now() < 12 * 60 * 60 * 1000
  return (
    <span
      className={`text-xs ${isUrgent ? 'text-amber-600 font-medium' : 'text-gray-500'}`}
      title={format(expDate, 'MMM d, yyyy h:mm a')}
    >
      {status === 'EXTENSION_REQUESTED' ? 'Held until' : 'Expires'} {format(expDate, 'MMM d, h:mm a')} ({remaining} left)
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

/** The status as this page shows it. */
const statusLabel = (status: string) => STATUS_LABEL[status] ?? status

/**
 * The dates a client may ask to extend a booking to, or why not. The whole
 * booking is extended (lib/bookings.ts clientExtendRefusal), from the day
 * after it now lapses to 3 days before it starts (lib/holdExpiry.ts
 * lastExpiryDate, the default runway); the server checks the same.
 */
function extendWindow(rows: HoldRequest[]): { min: string; max: string } | { refusal: string } {
  const refusal = clientExtendRefusal(rows)
  if (refusal) return { refusal }
  const held = rows.filter(r => r.status === 'HOLD')
  const today = new Date().toISOString().slice(0, 10)
  const max = lastExpiryDate([...bookingCapStarts(held, today)].sort()[0])
  const lapses = held.map(r => r.expires_at?.slice(0, 10)).filter((d): d is string => !!d).sort().reverse()[0] ?? today
  const after = new Date(lapses + 'T00:00:00Z')
  after.setUTCDate(after.getUTCDate() + 1)
  const min = [after.toISOString().slice(0, 10), today].sort().reverse()[0]
  return min > max ? { refusal: 'This booking starts too soon to be extended.' } : { min, max }
}

const SORT_COLUMNS = [
  { key: 'truck', label: 'Truck' },
  { key: 'market', label: 'Market' },
  { key: 'dates', label: 'Dates' },
  { key: 'pricing', label: 'Pricing' },
  { key: 'status', label: 'Status' },
] as const
type SortKey = typeof SORT_COLUMNS[number]['key']
const SORT_KEYS = SORT_COLUMNS.map(c => c.key)

function sortValue(r: HoldRequest, key: SortKey): SortValue {
  switch (key) {
    case 'truck':   return r.truck_number
    case 'market':  return formatMarketState(r.market, r.state)
    case 'dates':   return `${r.start_date} ${r.end_date}`
    case 'pricing': return r.quoted_total
    case 'status':  return statusLabel(r.status)
  }
}

export default function ClientHoldRequestsPage() {
  const { clientUser, authChecked } = useClientAuth()

  const [requests,     setRequests]     = useState<HoldRequest[]>([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  // The booking (or single hold) whose extension form is open.
  const [extending,     setExtending]     = useState<string | null>(null)
  const [extendReason,  setExtendReason]  = useState('')
  const [extendUntil,   setExtendUntil]   = useState('')
  const [extendError,   setExtendError]   = useState('')
  const [submitting,    setSubmitting]    = useState(false)

  const fetchRequests = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/client/hold-requests')
      if (!res.ok) throw new Error()
      const data = await res.json()
      setRequests(data.holdRequests || [])
    } catch {
      setError('Unable to load your hold requests. Please try again later.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (authChecked && clientUser && hasHoldRequestsAccess(clientUser)) fetchRequests()
    else if (authChecked) setLoading(false)
  }, [authChecked, clientUser, fetchRequests])

  const closeExtend = () => { setExtending(null); setExtendReason(''); setExtendUntil(''); setExtendError('') }

  // ONE request for the whole booking: the server finds every hold in it from
  // the one named here and marks them all, in one transaction.
  const requestExtension = useCallback(async (holdId: string) => {
    if (!extendUntil) return
    setSubmitting(true)
    setExtendError('')
    try {
      const res = await fetch(`/api/client/hold-requests/${holdId}/extend`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ reason: extendReason, extend_until: extendUntil }),
      })
      if (res.ok) {
        closeExtend()
        fetchRequests()
      } else {
        const err = await res.json().catch(() => ({}))
        setExtendError(err.error || 'The request could not be sent. Please try again.')
      }
    } catch {
      setExtendError('The request could not be sent. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }, [extendReason, extendUntil, fetchRequests])

  const { sort, sortBy, chooseSort } = useTableSort<SortKey>('client.holdRequests.sort', SORT_KEYS)

  // One card per booking (every market and truck of one quote), filtered by
  // the booking's status, never part of one. Holds that belong to no booking
  // are rows of their own. Memoized, so typing an extension reason does not
  // regroup and re-sort the list.
  const { sortedGroups, sortedUngrouped, shown } = useMemo(() => {
    const grouped = new Map<string, HoldRequest[]>()
    const ungrouped: HoldRequest[] = []
    for (const r of requests) {
      if (r.booking) grouped.set(r.booking, [...(grouped.get(r.booking) ?? []), r])
      else ungrouped.push(r)
    }
    const keep = (status: string) => !filterStatus || status === filterStatus
    const groups = Array.from(grouped.entries()).filter(([, rows]) => keep(bookingStatus(rows).status))
    const singles = ungrouped.filter(r => keep(r.status))
    return {
      shown: groups.length + singles.length,
      sortedUngrouped: sortRows(singles, sort, sortValue),
      sortedGroups: sortRows(
        groups.map(([id, rows]) => [id, sortRows(rows, sort, sortValue)] as const),
        sort,
        ([, rows], key) => (key === 'truck' ? minValue(rows.map(r => r.truck_number)) : sortValue(rows[0], key)),
      ),
    }
  }, [requests, filterStatus, sort])

  // Render helpers, called as functions (not components): a component defined
  // inside the page would remount its inputs on every keystroke.

  /** The extension form for a booking (or a single hold): its dates and reason. */
  function extendForm(rows: HoldRequest[], inline: boolean) {
    const w = extendWindow(rows)
    if ('refusal' in w) return null
    const target = rows.find(r => r.status === 'HOLD')!
    const fields = (
      <>
        <div>
          <label className="text-xs font-medium text-gray-600 mb-0.5 block">Extend until <span className="text-red-500">*</span></label>
          <input
            type="date"
            value={extendUntil}
            min={w.min}
            max={w.max}
            onChange={(e) => setExtendUntil(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
          <p className="text-[11px] text-gray-400 mt-0.5">Up to {format(parseDateOnly(w.max), 'MMM d')}, 3 days before it starts.</p>
        </div>
        <input
          type="text"
          placeholder="Reason (optional)"
          value={extendReason}
          onChange={(e) => setExtendReason(e.target.value)}
          className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
        />
      </>
    )
    const buttons = (
      <>
        <button
          onClick={() => requestExtension(target.id)}
          disabled={!extendUntil || submitting}
          className="bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
        >
          {submitting ? 'Sending…' : 'Submit'}
        </button>
        <button onClick={closeExtend} className="text-gray-500 hover:text-gray-700 px-2 py-1.5 text-sm transition-colors">
          Cancel
        </button>
      </>
    )
    return inline ? (
      <div className="space-y-2">
        <div className="flex gap-2 items-end flex-wrap">{fields}{buttons}</div>
        {extendError && <p className="text-xs text-red-600">{extendError}</p>}
      </div>
    ) : (
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={closeExtend}>
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6 space-y-3" onClick={(e) => e.stopPropagation()}>
          <h3 className="font-semibold text-gray-900">Request Hold Extension</h3>
          <div className="flex flex-col gap-2">{fields}</div>
          {extendError && <p className="text-xs text-red-600">{extendError}</p>}
          <div className="flex gap-2 justify-end">{buttons}</div>
        </div>
      </div>
    )
  }

  /** The "Request Hold Extension" link, or why the booking can't be extended (when it is a live reservation). */
  function extendLink(rows: HoldRequest[], id: string) {
    const w = extendWindow(rows)
    if ('refusal' in w) {
      return bookingStatus(rows).status === 'HOLD' ? <span className="text-xs text-gray-400">{w.refusal}</span> : null
    }
    return (
      <button onClick={() => { closeExtend(); setExtending(id) }} className="text-amber-700 hover:text-amber-800 text-xs font-medium">
        Request Hold Extension
      </button>
    )
  }

  return (
    <div className="flex flex-col h-dvh overflow-hidden bg-gray-50">
      <ClientHeader clientUser={clientUser} authChecked={authChecked} />

      <div className="flex-1 overflow-auto p-4 sm:p-6 max-w-5xl mx-auto w-full">
        {!authChecked ? (
          <TableSkeleton />
        ) : !clientUser ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <p className="text-gray-500 font-medium">Log in to view your hold requests</p>
            <Link href="/client/login" className="mt-4 bg-[#1a3028] text-white px-4 py-2 rounded-lg text-sm hover:bg-[#1a3028]/90">
              Log in
            </Link>
          </div>
        ) : !hasHoldRequestsAccess(clientUser) ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <p className="text-gray-500 font-medium">This page isn&apos;t available on your account yet.</p>
            <Link href="/client" className="mt-4 bg-[#1a3028] text-white px-4 py-2 rounded-lg text-sm hover:bg-[#1a3028]/90">
              Back to Schedule
            </Link>
          </div>
        ) : (
          <>
            <div className="flex items-start sm:items-center justify-between mb-4 sm:mb-6 gap-3">
              <div>
                <h1 className="text-2xl font-bold text-gray-900">My Hold Requests</h1>
                <p className="text-sm text-gray-500 mt-0.5">Your reservations, one per booking, and their status</p>
              </div>
              <div className="flex gap-2 flex-shrink-0 flex-wrap">
                {FILTERS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setFilterStatus(s)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                      filterStatus === s
                        ? 'bg-green-600 text-white border-green-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {s ? statusLabel(s) : 'All'}
                  </button>
                ))}
              </div>
            </div>

            {error ? (
              <div className="flex flex-col items-center justify-center h-64 text-center">
                <p className="text-gray-500 font-medium">{error}</p>
                <button onClick={fetchRequests} className="mt-4 bg-green-600 hover:bg-green-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">Retry</button>
              </div>
            ) : loading ? (
              <TableSkeleton />
            ) : shown === 0 ? (
              <div className="text-center py-20 text-gray-400">
                <p className="font-medium">No hold requests found</p>
                <p className="text-sm mt-1">Use the AI Assistant to check availability, get a quote, and place a hold</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex justify-end">
                  <SortSelect columns={SORT_COLUMNS} sort={sort} onChange={chooseSort} defaultLabel="Newest first" />
                </div>
                {/* Bookings: one card each, every market and truck in it */}
                {sortedGroups.map(([bookingId, groupItems]) => {
                  const { status } = bookingStatus(groupItems)
                  const live = groupItems.filter(r => r.status === status)
                  const first = live[0] ?? groupItems[0]
                  const summary = summarizeBooking(groupItems.map(r => ({ ...r, sfdc_opportunity_id: null })))
                  const markets = marketGroups(groupItems.map(r => ({ ...r, sfdc_opportunity_id: null })))
                  const multi = markets.length > 1
                  return (
                    <div key={bookingId} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                      {/* Booking header */}
                      <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-semibold text-gray-900">
                            {summary.trucks} truck{summary.trucks === 1 ? '' : 's'} &middot; {multi ? `${markets.length} markets` : formatMarketState(first.market, first.state)}
                          </span>
                          <span className="text-xs text-gray-500">
                            {format(parseDateOnly(summary.start), 'MMM d')} &ndash; {format(parseDateOnly(summary.end), 'MMM d, yyyy')}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <PricingBadge tier={summary.tier} total={summary.total} />
                          <ExpirationBadge expiresAt={summarizeBooking(live.map(r => ({ ...r, sfdc_opportunity_id: null }))).earliestExpiry} status={status} />
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[status] ?? STATUS_BADGE.HOLD}`}>
                            {statusLabel(status)}
                          </span>
                        </div>
                      </div>
                      {/* Quote breakdown — one market's breakdown would misstate a multi-market booking */}
                      {(() => {
                        const parsedFeatures = multi ? null : parseQuoteFeatures(first.features)
                        return parsedFeatures ? (
                          <div className="px-4 py-3 bg-white border-b border-gray-100">
                            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Quote breakdown</div>
                            <QuoteBreakdown features={parsedFeatures} />
                          </div>
                        ) : null
                      })()}
                      {/* Markets in flight order, each with its trucks */}
                      <div className="divide-y divide-gray-100">
                        {markets.map((m) => (
                          <div key={m.key}>
                            {multi && (
                              <div className="px-4 py-2 bg-gray-50 flex items-center justify-between text-sm">
                                <span className="font-semibold text-gray-900">{formatMarketState(m.market, m.rows[0].state)}</span>
                                <span className="text-xs text-gray-600">
                                  {format(parseDateOnly(m.start), 'MMM d')} &ndash; {format(parseDateOnly(m.end), 'MMM d, yyyy')}
                                </span>
                              </div>
                            )}
                            {m.rows.map((r) => (
                              <div key={r.id} className={`${multi ? 'pl-8' : 'px-4'} pr-4 py-2.5 flex items-center justify-between text-sm`}>
                                <span className="font-medium text-gray-900">Truck {r.truck_number}</span>
                                {!multi && <span className="text-gray-500">{formatMarketState(r.market, r.state)}</span>}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                      {status === 'EXTENSION_REQUESTED' && (
                        <div className="px-4 py-2 text-xs text-amber-800 bg-amber-50 border-t border-amber-100">
                          Extension requested{first.extension_until ? ` to ${format(parseDateOnly(first.extension_until), 'MMM d')}` : ''}. The Lime Media team will confirm by email.
                        </div>
                      )}
                      {/* Extension: the whole booking at once */}
                      {status === 'HOLD' && (
                        <div className="px-4 py-2.5 border-t border-gray-100 bg-gray-50">
                          {extending === bookingId ? extendForm(groupItems, true) : extendLink(groupItems, bookingId)}
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* Holds that belong to no booking (legacy single-truck rows) */}
                {sortedUngrouped.length > 0 && (
                  <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50/80 border-b border-gray-200">
                          <tr>
                            {SORT_COLUMNS.map((c) => (
                              <SortableTh key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={sortBy} />
                            ))}
                            <SortableTh label="" sort={sort} onSort={sortBy} />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {sortedUngrouped.map((r) => {
                            const parsedFeatures = parseQuoteFeatures(r.features)
                            return (
                              <Fragment key={r.id}>
                                <tr className="hover:bg-gray-50 transition-colors">
                                  <td className="px-4 py-3 font-semibold text-gray-900">{r.truck_number}</td>
                                  <td className="px-4 py-3 text-gray-600">{formatMarketState(r.market, r.state)}</td>
                                  <td className="px-4 py-3 text-gray-600">
                                    {format(parseDateOnly(r.start_date), 'MMM d')} &ndash; {format(parseDateOnly(r.end_date), 'MMM d')}
                                  </td>
                                  <td className="px-4 py-3">
                                    <PricingBadge tier={r.pricing_tier} total={r.quoted_total} />
                                  </td>
                                  <td className="px-4 py-3">
                                    <div className="flex items-center gap-2">
                                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[r.status] ?? STATUS_BADGE.HOLD}`}>
                                        {statusLabel(r.status)}
                                      </span>
                                      <ExpirationBadge expiresAt={r.expires_at} status={r.status} />
                                    </div>
                                  </td>
                                  <td className="px-4 py-3">
                                    {r.status === 'HOLD' && extendLink([r], r.id)}
                                  </td>
                                </tr>
                                {parsedFeatures && (
                                  <tr className="bg-gray-50/50">
                                    <td colSpan={6} className="px-4 pb-3 pt-0">
                                      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Quote breakdown</div>
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

            {/* Extension form for a hold that belongs to no booking */}
            {extending && (() => {
              const single = sortedUngrouped.find(r => r.id === extending)
              return single ? extendForm([single], false) : null
            })()}
          </>
        )}
      </div>
    </div>
  )
}

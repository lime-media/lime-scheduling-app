'use client'

import { Fragment, useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { format, formatDistanceToNow, isPast } from 'date-fns'
import { ClientHeader } from '@/components/ClientHeader'
import { TableSkeleton } from '@/components/LoadingSkeleton'
import { useClientAuth, hasHoldRequestsAccess } from '@/lib/useClientAuth'
import { parseDateOnly } from '@/lib/dateOnly'
import { formatMarketState } from '@/lib/format'
import { parseQuoteFeatures, QuoteBreakdown } from '@/components/QuoteBreakdown'

type HoldRequest = {
  id: string
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
  PENDING:              'bg-purple-100 text-purple-800 border border-purple-200',
  APPROVED:             'bg-green-100 text-green-800 border border-green-200',
  REJECTED:             'bg-red-100 text-red-800 border border-red-200',
  EXPIRED:              'bg-gray-100 text-gray-500 border border-gray-200',
  EXTENSION_REQUESTED:  'bg-amber-100 text-amber-800 border border-amber-200',
}

function fmtMoney(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

function ExpirationBadge({ expiresAt, status }: { expiresAt: string | null; status: string }) {
  if (!expiresAt || status === 'REJECTED') return null
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
      Expires {format(expDate, 'MMM d, h:mm a')} ({remaining} left)
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

export default function ClientHoldRequestsPage() {
  const { clientUser, authChecked } = useClientAuth()

  const [requests,     setRequests]     = useState<HoldRequest[]>([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [extending,     setExtending]     = useState<string | null>(null)
  const [extendReason,  setExtendReason]  = useState('')
  const [extendUntil,   setExtendUntil]   = useState('')

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

  // Takes every hold-request ID in the campaign — a multi-truck campaign must extend as one
  // unit, not just the first truck in the group (which silently left the rest to expire on
  // their own while the group badge misleadingly showed "Extension Requested" for all of them).
  const requestExtension = useCallback(async (ids: string[]) => {
    if (!extendUntil) return
    try {
      const results = await Promise.all(ids.map((id) =>
        fetch(`/api/client/hold-requests/${id}/extend`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ reason: extendReason, extend_until: extendUntil }),
        })
      ))
      if (results.every((r) => r.ok)) {
        setExtending(null)
        setExtendReason('')
        setExtendUntil('')
        fetchRequests()
      }
    } catch { /* handled by UI */ }
  }, [extendReason, extendUntil, fetchRequests])

  const filtered = filterStatus ? requests.filter((r) => r.status === filterStatus) : requests

  // Group by campaign_group_id for display
  const grouped = new Map<string, HoldRequest[]>()
  const ungrouped: HoldRequest[] = []
  for (const r of filtered) {
    if (r.campaign_group_id) {
      const group = grouped.get(r.campaign_group_id) ?? []
      group.push(r)
      grouped.set(r.campaign_group_id, group)
    } else {
      ungrouped.push(r)
    }
  }

  const canExtend = (r: HoldRequest) =>
    ['PENDING', 'APPROVED', 'EXPIRED'].includes(r.status) && r.status !== 'EXTENSION_REQUESTED'

  return (
    <div className="flex flex-col h-dvh overflow-hidden">
      <ClientHeader clientUser={clientUser} authChecked={authChecked} />

      <div className="flex-1 overflow-auto p-4 sm:p-6 max-w-5xl mx-auto w-full">
        {!authChecked ? (
          <TableSkeleton />
        ) : !clientUser ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <div className="text-5xl mb-4">&#128274;</div>
            <p className="text-gray-600 font-medium">Log in to view your hold requests</p>
            <Link href="/client/login" className="mt-4 bg-[#1a3028] text-white px-4 py-2 rounded-lg text-sm hover:bg-[#1a3028]/90">
              Log in
            </Link>
          </div>
        ) : !hasHoldRequestsAccess(clientUser) ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <div className="text-5xl mb-4">&#128679;</div>
            <p className="text-gray-600 font-medium">This page isn&apos;t available on your account yet.</p>
            <Link href="/client" className="mt-4 bg-[#1a3028] text-white px-4 py-2 rounded-lg text-sm hover:bg-[#1a3028]/90">
              Back to Schedule
            </Link>
          </div>
        ) : (
          <>
            <div className="flex items-start sm:items-center justify-between mb-4 sm:mb-6 gap-3">
              <div>
                <h1 className="text-xl sm:text-2xl font-bold text-gray-900">My Hold Requests</h1>
                <p className="text-sm text-gray-500 mt-0.5">Requests you&apos;ve submitted, and their review status</p>
              </div>
              <div className="flex gap-2 flex-shrink-0 flex-wrap">
                {(['', 'PENDING', 'APPROVED', 'EXPIRED', 'REJECTED'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setFilterStatus(s)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                      filterStatus === s
                        ? 'bg-green-700 text-white border-green-700'
                        : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {s || 'All'}
                  </button>
                ))}
              </div>
            </div>

            {error ? (
              <div className="flex flex-col items-center justify-center h-64 text-center">
                <div className="text-5xl mb-4">&#9888;&#65039;</div>
                <p className="text-gray-600 font-medium">{error}</p>
                <button onClick={fetchRequests} className="mt-4 bg-green-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-800">Retry</button>
              </div>
            ) : loading ? (
              <TableSkeleton />
            ) : filtered.length === 0 ? (
              <div className="text-center py-20 text-gray-400">
                <div className="text-5xl mb-3">&#128203;</div>
                <p className="font-medium">No hold requests found</p>
                <p className="text-sm mt-1">Use the AI Assistant to check availability, get a quote, and place a hold</p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Campaign groups */}
                {Array.from(grouped.entries()).map(([groupId, groupItems]) => {
                  const first = groupItems[0]
                  return (
                    <div key={groupId} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                      {/* Campaign header */}
                      <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-semibold text-gray-900">
                            {first.truck_count ?? groupItems.length} truck{(first.truck_count ?? groupItems.length) === 1 ? '' : 's'} &middot; {first.market}
                          </span>
                          <span className="text-xs text-gray-500">
                            {format(parseDateOnly(first.start_date), 'MMM d')} &ndash; {format(parseDateOnly(first.end_date), 'MMM d, yyyy')}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <PricingBadge tier={first.pricing_tier} total={first.quoted_total} />
                          <ExpirationBadge expiresAt={first.expires_at} status={first.status} />
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[first.status] ?? STATUS_BADGE.PENDING}`}>
                            {first.status === 'EXTENSION_REQUESTED' ? 'Extension Requested' : first.status}
                          </span>
                        </div>
                      </div>
                      {/* Quote breakdown — what's actually being paid for, not just a tier name */}
                      {(() => {
                        const parsedFeatures = parseQuoteFeatures(first.features)
                        return parsedFeatures ? (
                          <div className="px-4 py-3 bg-white border-b border-gray-100">
                            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Quote breakdown</div>
                            <QuoteBreakdown features={parsedFeatures} />
                          </div>
                        ) : null
                      })()}
                      {/* Truck rows */}
                      <div className="divide-y divide-gray-100">
                        {groupItems.map((r) => (
                          <div key={r.id} className="px-4 py-2.5 flex items-center justify-between text-sm">
                            <span className="font-medium text-gray-900">Truck {r.truck_number}</span>
                            <span className="text-gray-500">{formatMarketState(r.market, r.state)}</span>
                          </div>
                        ))}
                      </div>
                      {/* Extension action */}
                      {canExtend(first) && (() => {
                        // Min date: the later of today and the current expiration
                        const today = new Date().toISOString().split('T')[0]
                        const expiresDate = first.expires_at ? first.expires_at.split('T')[0] : today
                        const minDate = expiresDate > today ? expiresDate : today
                        // Max date: day before campaign start
                        const startDate = new Date(first.start_date + 'T00:00:00Z')
                        startDate.setUTCDate(startDate.getUTCDate() - 1)
                        const maxDate = startDate.toISOString().split('T')[0]

                        return (
                          <div className="px-4 py-2.5 border-t border-gray-100 bg-gray-50">
                            {extending === first.id ? (
                              <div className="space-y-2">
                                <div className="flex gap-2 items-end">
                                  <div>
                                    <label className="text-xs font-medium text-gray-600 mb-0.5 block">Extend until <span className="text-red-500">*</span></label>
                                    <input
                                      type="date"
                                      value={extendUntil}
                                      min={minDate}
                                      max={maxDate}
                                      onChange={(e) => setExtendUntil(e.target.value)}
                                      className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                                    />
                                  </div>
                                  <input
                                    type="text"
                                    placeholder="Reason (optional)"
                                    value={extendReason}
                                    onChange={(e) => setExtendReason(e.target.value)}
                                    className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                                  />
                                  <button
                                    onClick={() => requestExtension(groupItems.map((g) => g.id))}
                                    disabled={!extendUntil}
                                    className="bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-sm font-medium"
                                  >
                                    Submit
                                  </button>
                                  <button
                                    onClick={() => { setExtending(null); setExtendReason(''); setExtendUntil('') }}
                                    className="text-gray-500 hover:text-gray-700 px-2 py-1.5 text-sm"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <button
                                onClick={() => setExtending(first.id)}
                                className="text-amber-700 hover:text-amber-800 text-xs font-medium"
                              >
                                Request Hold Extension
                              </button>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                  )
                })}

                {/* Ungrouped (legacy or single-truck holds without pricing) */}
                {ungrouped.length > 0 && (
                  <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 border-b border-gray-200">
                          <tr>
                            {['Truck', 'Market', 'Dates', 'Pricing', 'Status', ''].map((col) => (
                              <th key={col} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {ungrouped.map((r) => {
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
                                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[r.status] ?? STATUS_BADGE.PENDING}`}>
                                        {r.status === 'EXTENSION_REQUESTED' ? 'Ext. Req.' : r.status}
                                      </span>
                                      <ExpirationBadge expiresAt={r.expires_at} status={r.status} />
                                    </div>
                                  </td>
                                  <td className="px-4 py-3">
                                    {canExtend(r) && (
                                      <button
                                        onClick={() => setExtending(r.id)}
                                        className="text-amber-700 hover:text-amber-800 text-xs font-medium"
                                      >
                                        Request Hold Extension
                                      </button>
                                    )}
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

            {/* Extension modal for ungrouped holds */}
            {extending && !Array.from(grouped.values()).flat().some(r => r.id === extending) && (() => {
              const holdReq = ungrouped.find(r => r.id === extending)
              if (!holdReq) return null
              const today = new Date().toISOString().split('T')[0]
              const expiresDate = holdReq.expires_at ? holdReq.expires_at.split('T')[0] : today
              const minDate = expiresDate > today ? expiresDate : today
              const startDate = new Date(holdReq.start_date + 'T00:00:00Z')
              startDate.setUTCDate(startDate.getUTCDate() - 1)
              const maxDate = startDate.toISOString().split('T')[0]

              return (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => { setExtending(null); setExtendReason(''); setExtendUntil('') }}>
                  <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
                    <h3 className="font-semibold text-gray-900 mb-3">Request Hold Extension</h3>
                    <div className="mb-3">
                      <label className="text-xs font-medium text-gray-600 mb-1 block">Extend until <span className="text-red-500">*</span></label>
                      <input
                        type="date"
                        value={extendUntil}
                        min={minDate}
                        max={maxDate}
                        onChange={(e) => setExtendUntil(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                      />
                    </div>
                    <textarea
                      placeholder="Reason (optional)"
                      value={extendReason}
                      onChange={(e) => setExtendReason(e.target.value)}
                      rows={2}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none mb-4"
                    />
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => { setExtending(null); setExtendReason(''); setExtendUntil('') }} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
                      <button
                        onClick={() => requestExtension([extending])}
                        disabled={!extendUntil}
                        className="bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium"
                      >
                        Submit Request
                      </button>
                    </div>
                  </div>
                </div>
              )
            })()}
          </>
        )}
      </div>
    </div>
  )
}

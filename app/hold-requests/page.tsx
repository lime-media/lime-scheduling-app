'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { format, formatDistanceToNow, isPast } from 'date-fns'
import toast from 'react-hot-toast'
import { Navbar } from '@/components/Navbar'
import { TableSkeleton } from '@/components/LoadingSkeleton'
import { parseDateOnly } from '@/lib/dateOnly'
import { formatMarketState } from '@/lib/format'

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
  truck_count: number | null
  campaign_group_id: string | null
  expires_at: string | null
  extension_reason: string | null
  created_at: string
}

const STATUS_BADGE: Record<string, string> = {
  PENDING:              'bg-purple-100 text-purple-800 border border-purple-200',
  APPROVED:             'bg-green-100 text-green-800 border border-green-200',
  REJECTED:             'bg-red-100 text-red-800 border border-red-200',
  EXPIRED:              'bg-gray-100 text-gray-500 border border-gray-200',
  EXTENSION_REQUESTED:  'bg-amber-100 text-amber-800 border border-amber-200',
}

const STATUS_LABEL: Record<string, string> = {
  EXTENSION_REQUESTED: 'Extension Requested',
}

function fmtMoney(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

function ExpirationBadge({ expiresAt, status }: { expiresAt: string | null; status: string }) {
  if (!expiresAt || status === 'REJECTED') return null
  const expDate = new Date(expiresAt)

  if (status === 'EXPIRED') {
    return <span className="text-xs text-gray-400">Expired</span>
  }

  if (isPast(expDate)) {
    return <span className="text-xs text-red-500 font-medium">Expiring...</span>
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

export default function HoldRequestsPage() {
  const [requests,     setRequests]     = useState<HoldRequest[]>([])
  const [loading,      setLoading]      = useState(true)
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [search,       setSearch]       = useState('')
  const [acting,       setActing]       = useState<string | null>(null) // group/row id currently mid-action

  const fetchRequests = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/hold-requests')
      if (!res.ok) throw new Error()
      const data = await res.json()
      setRequests(data.holdRequests || [])
    } catch (err) {
      toast.error('Failed to load hold requests')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchRequests() }, [fetchRequests])

  // Runs `action` against every id (a whole campaign group at once, or a single ungrouped row),
  // reports partial failures individually since one truck in a group can fail (e.g. a conflict)
  // while the rest succeed, and refetches once regardless so the list reflects whatever did land.
  const runAction = useCallback(async (ids: string[], action: 'approve' | 'reject' | 'approve_extension' | 'deny_extension', groupKey: string) => {
    setActing(groupKey)
    try {
      const results = await Promise.all(ids.map(async (id) => {
        const res = await fetch(`/api/hold-requests/${id}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ action }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          return { id, ok: false, error: err.error || 'Failed' }
        }
        return { id, ok: true }
      }))

      const failed = results.filter((r) => !r.ok)
      const succeeded = results.length - failed.length
      const actionLabel = action.replace('_', ' ')
      if (failed.length === 0) {
        toast.success(`${actionLabel} — ${succeeded} truck${succeeded === 1 ? '' : 's'}`)
      } else if (succeeded > 0) {
        toast.error(`${actionLabel}: ${succeeded} succeeded, ${failed.length} failed — ${failed[0].error}`)
      } else {
        toast.error(failed[0].error || `Failed to ${actionLabel}`)
      }
    } finally {
      setActing(null)
      fetchRequests()
    }
  }, [fetchRequests])

  const filtered = useMemo(
    () => {
      let result = filterStatus ? requests.filter((r) => r.status === filterStatus) : requests
      const q = search.trim().toLowerCase()
      if (q) {
        result = result.filter((r) =>
          [r.company_name, r.truck_number, r.market, r.notes]
            .filter(Boolean)
            .some((field) => field!.toLowerCase().includes(q))
        )
      }
      return result
    },
    [requests, filterStatus, search]
  )

  // Group by campaign_group_id so a multi-truck campaign is reviewed and acted on as one unit.
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

  function Actions({ ids, status, groupKey }: { ids: string[]; status: string; groupKey: string }) {
    const busy = acting === groupKey
    if (status === 'PENDING') {
      return (
        <div className="flex items-center gap-2">
          <button
            disabled={busy}
            onClick={() => runAction(ids, 'approve', groupKey)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-green-700 hover:bg-green-800 text-white disabled:opacity-50"
          >
            Approve
          </button>
          <button
            disabled={busy}
            onClick={() => runAction(ids, 'reject', groupKey)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      )
    }
    if (status === 'EXTENSION_REQUESTED') {
      // Three distinct outcomes here, not two — a request sitting in EXTENSION_REQUESTED can
      // still be rejected outright (the client asked for more time, but the answer might be "no,
      // and not later either"), which is different from just denying the extension itself (the
      // request stays EXPIRED, open to another extension ask). Without an explicit Reject here,
      // "Deny" was the only negative-sounding button and got clicked to mean "reject this whole
      // request" — it doesn't; it only denies the extension. See commit fixing this.
      return (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            disabled={busy}
            onClick={() => runAction(ids, 'approve_extension', groupKey)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50"
          >
            Approve Extension
          </button>
          <button
            disabled={busy}
            onClick={() => runAction(ids, 'deny_extension', groupKey)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            Deny Extension
          </button>
          <button
            disabled={busy}
            onClick={() => runAction(ids, 'reject', groupKey)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            Reject Request
          </button>
        </div>
      )
    }
    return null
  }

  return (
    <div className="flex flex-col min-h-dvh">
      <Navbar />

      <div className="flex-1 p-4 sm:p-6 max-w-7xl mx-auto w-full">
        {/* Header */}
        <div className="flex items-start sm:items-center justify-between mb-4 gap-3 flex-wrap">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Hold Requests</h1>
            <p className="text-sm text-gray-500 mt-0.5">Review client-submitted hold requests — approve, reject, or resolve extension requests</p>
          </div>
          <div className="flex gap-2 flex-shrink-0 flex-wrap">
            {(['', 'PENDING', 'EXTENSION_REQUESTED', 'APPROVED', 'EXPIRED', 'REJECTED'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilterStatus(s)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                  filterStatus === s
                    ? 'bg-green-700 text-white border-green-700'
                    : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                }`}
              >
                {s ? (STATUS_LABEL[s] ?? s) : 'All'}
              </button>
            ))}
          </div>
        </div>

        {/* Search */}
        <div className="relative max-w-md mb-4 sm:mb-6">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 104.35 4.35a7.5 7.5 0 0012.3 12.3z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by client, truck, market, or notes…"
            className="w-full border border-gray-300 rounded-lg pl-9 pr-8 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          {search && (
            <button onClick={() => setSearch('')} aria-label="Clear search" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              ✕
            </button>
          )}
        </div>

        {loading ? (
          <TableSkeleton />
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-gray-400">
            <div className="text-5xl mb-3">📋</div>
            <p className="font-medium">No hold requests found</p>
            <p className="text-sm mt-1">
              {search || filterStatus ? 'Try a different search term or filter' : 'Requests submitted by clients will show up here'}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Campaign groups — one card per campaign, actions apply to every truck in it */}
            {Array.from(grouped.entries()).map(([groupId, groupItems]) => {
              const first = groupItems[0]
              const ids = groupItems.map((g) => g.id)
              return (
                <div key={groupId} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900">
                        {first.company_name} — {first.truck_count ?? groupItems.length} truck{(first.truck_count ?? groupItems.length) === 1 ? '' : 's'} · {formatMarketState(first.market, first.state)}
                      </span>
                      <span className="text-xs text-gray-500">
                        {format(parseDateOnly(first.start_date), 'MMM d')} &ndash; {format(parseDateOnly(first.end_date), 'MMM d, yyyy')}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <PricingBadge tier={first.pricing_tier} total={first.quoted_total} />
                      <ExpirationBadge expiresAt={first.expires_at} status={first.status} />
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[first.status] ?? STATUS_BADGE.PENDING}`}>
                        {STATUS_LABEL[first.status] ?? first.status}
                      </span>
                    </div>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {groupItems.map((r) => (
                      <div key={r.id} className="px-4 py-2.5 flex items-center justify-between text-sm">
                        <span className="font-medium text-gray-900">Truck {r.truck_number}</span>
                        <span className="text-gray-500">{formatMarketState(r.market, r.state)}</span>
                      </div>
                    ))}
                  </div>
                  {first.status === 'EXTENSION_REQUESTED' && first.extension_reason && (
                    <div className="px-4 py-2 text-xs text-amber-800 bg-amber-50 border-t border-amber-100">
                      Reason: {first.extension_reason}
                    </div>
                  )}
                  {(first.status === 'PENDING' || first.status === 'EXTENSION_REQUESTED') && (
                    <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
                      <Actions ids={ids} status={first.status} groupKey={groupId} />
                    </div>
                  )}
                </div>
              )
            })}

            {/* Ungrouped (single-truck requests without a campaign group, or legacy rows) */}
            {ungrouped.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        {['Truck', 'Client', 'Market', 'Dates', 'Pricing', 'Status', 'Expires', 'Actions'].map((col) => (
                          <th key={col} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {ungrouped.map((r) => (
                        <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3 font-semibold text-gray-900">{r.truck_number}</td>
                          <td className="px-4 py-3 text-gray-600">{r.company_name}</td>
                          <td className="px-4 py-3 text-gray-600">{formatMarketState(r.market, r.state)}</td>
                          <td className="px-4 py-3 text-gray-600">
                            {format(parseDateOnly(r.start_date), 'MMM d')} &ndash; {format(parseDateOnly(r.end_date), 'MMM d')}
                          </td>
                          <td className="px-4 py-3">
                            <PricingBadge tier={r.pricing_tier} total={r.quoted_total} />
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[r.status] ?? STATUS_BADGE.PENDING}`}>
                              {STATUS_LABEL[r.status] ?? r.status}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <ExpirationBadge expiresAt={r.expires_at} status={r.status} />
                          </td>
                          <td className="px-4 py-3">
                            <Actions ids={[r.id]} status={r.status} groupKey={r.id} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

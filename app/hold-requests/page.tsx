'use client'

import { Fragment, useState, useEffect, useCallback, useMemo } from 'react'
import { format, formatDistanceToNow, isPast } from 'date-fns'
import toast from 'react-hot-toast'
import { Navbar } from '@/components/Navbar'
import { TableSkeleton } from '@/components/LoadingSkeleton'
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
  created_at: string
}

const STATUS_BADGE: Record<string, string> = {
  HOLD:                 'bg-green-100 text-green-800 border border-green-200',
  COMMITTED:            'bg-green-100 text-green-800 border border-green-200',
  ATT_SOFT:             'bg-purple-100 text-purple-800 border border-purple-200',
  EXPIRED:              'bg-gray-100 text-gray-500 border border-gray-200',
  EXTENSION_REQUESTED:  'bg-amber-100 text-amber-800 border border-amber-200',
}

const STATUS_LABEL: Record<string, string> = {
  HOLD: 'Active',
  COMMITTED: 'Active',
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

function ExpirationBadge({ expiresAt, status }: { expiresAt: string | null; status: string }) {
  if (!expiresAt || status === 'COMMITTED') return null
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

type AvailableTruck = { truckNumber: string; currentMarket: string; distanceMiles: number; current: boolean }

export default function HoldRequestsPage() {
  const [requests,     setRequests]     = useState<HoldRequest[]>([])
  const [loading,      setLoading]      = useState(true)
  const [filterStatus, setFilterStatus] = useState<string>('HOLD')
  const [search,       setSearch]       = useState('')
  const [acting,       setActing]       = useState<string | null>(null) // group/row id currently mid-action

  // Edit modal state — supports multi-truck reservations
  const [editingGroup, setEditingGroup] = useState<HoldRequest[] | null>(null)
  const [availableTrucksMap, setAvailableTrucksMap] = useState<Map<string, AvailableTruck[]>>(new Map())
  const [trucksLoading, setTrucksLoading] = useState(false)
  const [selectedTrucks, setSelectedTrucks] = useState<Map<string, string>>(new Map()) // holdId -> selected truck
  const [cancelMode, setCancelMode] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [newExpiresAt, setNewExpiresAt] = useState('')
  const [saving, setSaving] = useState(false)

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

  const openEdit = async (request: HoldRequest) => {
    // Find all siblings in the same group
    const groupKey = request.campaign_group_id || request.sfdc_opportunity_id
    const siblings = groupKey
      ? requests.filter(r => (r.campaign_group_id || r.sfdc_opportunity_id) === groupKey)
      : [request]
    setEditingGroup(siblings)
    setSelectedTrucks(new Map(siblings.map(r => [r.id, r.truck_number])))
    setCancelMode(false)
    setCancelReason('')
    setNewExpiresAt(siblings[0].expires_at ? siblings[0].expires_at.split('T')[0] : '')
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
    const first = editingGroup[0]
    const truckChanges = editingGroup.filter(r => selectedTrucks.get(r.id) !== r.truck_number)
    const currentExpDate = first.expires_at ? first.expires_at.split('T')[0] : ''
    const expirationChanged = newExpiresAt !== currentExpDate

    if (truckChanges.length === 0 && !expirationChanged) {
      setEditingGroup(null)
      return
    }

    setSaving(true)
    try {
      // Truck swaps
      if (truckChanges.length > 0) {
        const results = await Promise.all(
          truckChanges.map(async (r) => {
            const newTruck = selectedTrucks.get(r.id)
            if (!newTruck) return { ok: true }
            const res = await fetch(`/api/hold-requests/${r.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'swap_truck', truck_number: newTruck }),
            })
            if (!res.ok) {
              const err = await res.json()
              return { ok: false, error: err.error }
            }
            return { ok: true }
          })
        )
        const failed = results.filter(r => !r.ok)
        if (failed.length > 0) {
          toast.error(failed[0].error || 'Some swaps failed')
        }
      }

      // Expiration update — apply to all holds in the group
      if (expirationChanged && newExpiresAt) {
        await Promise.all(
          editingGroup.map(async (r) => {
            await fetch(`/api/hold-requests/${r.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'update_expiration', expires_at: newExpiresAt }),
            })
          })
        )
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
      const results = await Promise.all(
        editingGroup.map(async (r) => {
          const res = await fetch(`/api/hold-requests/${r.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'cancel_notify', reason: cancelReason }),
          })
          return res.ok
        })
      )
      const succeeded = results.filter(Boolean).length
      if (succeeded === editingGroup.length) {
        toast.success(editingGroup[0].source === 'CLIENT' ? 'Reservation cancelled — client notified' : 'Reservation cancelled')
      } else {
        toast.error(`Cancelled ${succeeded} of ${editingGroup.length} trucks`)
      }
      setEditingGroup(null)
      fetchRequests()
    } catch {
      toast.error('Network error')
    } finally {
      setSaving(false)
    }
  }

  const filtered = useMemo(
    () => {
      let result = filterStatus
        ? requests.filter((r) => filterStatus === 'HOLD' ? (r.status === 'HOLD' || r.status === 'COMMITTED') : r.status === filterStatus)
        : requests
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

  // Group by campaign_group_id or sfdc_opportunity_id so multi-truck reservations
  // are reviewed as one unit. Salesforce pushes share sfdc_opportunity_id;
  // client holds share campaign_group_id.
  const grouped = new Map<string, HoldRequest[]>()
  const ungrouped: HoldRequest[] = []
  for (const r of filtered) {
    const groupKey = r.campaign_group_id || r.sfdc_opportunity_id
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

  function Actions({ ids, status, groupKey, requests: actionRequests }: { ids: string[]; status: string; groupKey: string; requests?: HoldRequest[] }) {
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

      <div className="flex-1 p-4 sm:p-6 max-w-7xl mx-auto w-full">
        {/* Header */}
        <div className="flex items-start sm:items-center justify-between mb-6 gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Reservations</h1>
            <p className="text-sm text-gray-500 mt-0.5">All hold requests and reservations — edit, cancel, or manage extensions</p>
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

        {/* Search */}
        <div className="relative max-w-md mb-6">
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
            {Array.from(grouped.entries()).map(([groupId, groupItems]) => {
              const first = groupItems[0]
              const ids = groupItems.map((g) => g.id)
              return (
                <div key={groupId} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="px-4 py-3 bg-gray-50/80 border-b border-gray-200 flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900">
                        {first.company_name} — {first.truck_count ?? groupItems.length} truck{(first.truck_count ?? groupItems.length) === 1 ? '' : 's'} · {formatMarketState(first.market, first.state)}
                      </span>
                      <span className="text-xs text-gray-500">
                        {format(parseDateOnly(first.start_date), 'MMM d')} &ndash; {format(parseDateOnly(first.end_date), 'MMM d, yyyy')}
                      </span>
                      {first.created_by_name && (
                        <span className="text-xs text-gray-400">by {first.created_by_name}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${SOURCE_BADGE[first.source] ?? SOURCE_BADGE.INTERNAL}`}>
                        {SOURCE_LABEL[first.source] ?? first.source}
                      </span>
                      <PricingBadge tier={first.pricing_tier} total={first.quoted_total} />
                      <ExpirationBadge expiresAt={first.expires_at} status={first.status} />
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[first.status] ?? STATUS_BADGE.HOLD}`}>
                        {STATUS_LABEL[first.status] ?? first.status}
                      </span>
                    </div>
                  </div>
                  {(() => {
                    const parsedFeatures = parseQuoteFeatures(first.features)
                    return parsedFeatures ? (
                      <div className="px-4 py-3 bg-white border-b border-gray-100">
                        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Quote breakdown</div>
                        <QuoteBreakdown features={parsedFeatures} />
                      </div>
                    ) : null
                  })()}
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
                  {(first.status === 'HOLD' || first.status === 'COMMITTED' || first.status === 'EXTENSION_REQUESTED') && (
                    <div className="px-4 py-3 border-t border-gray-100 bg-gray-50/80 flex items-center gap-2">
                      {first.status === 'EXTENSION_REQUESTED' ? (
                        <Actions ids={ids} status={first.status} groupKey={groupId} />
                      ) : (
                        <button
                          onClick={() => openEdit(first)}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                          Edit
                        </button>
                      )}
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
                    <thead className="bg-gray-50/80 border-b border-gray-200">
                      <tr>
                        {['Truck', 'Client', 'Market', 'Dates', 'Source', 'Created By', 'Pricing', 'Status', 'Expires', 'Actions'].map((col) => (
                          <th key={col} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
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
                                  {STATUS_LABEL[r.status] ?? r.status}
                                </span>
                              </td>
                              <td className="px-4 py-3">
                                <ExpirationBadge expiresAt={r.expires_at} status={r.status} />
                              </td>
                              <td className="px-4 py-3">
                                <Actions ids={[r.id]} status={r.status} groupKey={r.id} requests={[r]} />
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
        const currentExpDate = first.expires_at ? first.expires_at.split('T')[0] : ''
        const hasChanges = editingGroup.some(r => selectedTrucks.get(r.id) !== r.truck_number) || newExpiresAt !== currentExpDate
        return (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
              <div className="px-6 py-4 border-b border-gray-100">
                <h2 className="text-lg font-bold text-gray-900">Edit Reservation</h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  {first.company_name} &middot; {formatMarketState(first.market, first.state)} &middot;{' '}
                  {format(parseDateOnly(first.start_date), 'MMM d')} &ndash; {format(parseDateOnly(first.end_date), 'MMM d, yyyy')}
                  {editingGroup.length > 1 && <span className="ml-1">({editingGroup.length} trucks)</span>}
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
                                  <div className="text-xs text-gray-500 mb-1">Truck {r.truck_number}</div>
                                )}
                                {available.length > 1 ? (
                                  <select
                                    value={selectedTrucks.get(r.id) ?? r.truck_number}
                                    onChange={(e) => setSelectedTrucks(prev => new Map(prev).set(r.id, e.target.value))}
                                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent bg-white"
                                  >
                                    {available.map(t => (
                                      <option key={t.truckNumber} value={t.truckNumber}>
                                        {t.truckNumber}{t.current ? ' (current)' : ''} — {t.currentMarket || 'Unknown'}{!t.current && t.distanceMiles > 0 ? ` (${Math.round(t.distanceMiles)} mi)` : ''}
                                      </option>
                                    ))}
                                  </select>
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
                        <PricingBadge tier={first.pricing_tier} total={first.quoted_total} />
                      </div>
                    )}

                    {/* Expiration management */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Expiration Date</label>
                      {first.expires_at ? (
                        <input
                          type="date"
                          value={newExpiresAt}
                          onChange={(e) => setNewExpiresAt(e.target.value)}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                        />
                      ) : (
                        <div className="flex items-center gap-2">
                          <p className="text-sm text-gray-500">No expiration set</p>
                          <button
                            type="button"
                            onClick={() => {
                              const d = new Date()
                              d.setDate(d.getDate() + 3)
                              setNewExpiresAt(d.toISOString().split('T')[0])
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
                  </>
                ) : (
                  <div className="space-y-3">
                    <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                      <p className="text-sm font-medium text-red-800">
                        Cancel this reservation{editingGroup.length > 1 ? ` (${editingGroup.length} trucks)` : ''}?
                      </p>
                      <p className="text-xs text-red-600 mt-1">
                        {editingGroup.map(r => r.truck_number).join(', ')} &middot; {first.market} &middot;{' '}
                        {first.start_date} to {first.end_date}
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
                    <button
                      onClick={() => setCancelMode(true)}
                      className="flex-1 border border-red-200 text-red-600 rounded-lg py-2.5 text-sm font-medium hover:bg-red-50 transition-colors"
                    >
                      Cancel & Notify
                    </button>
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
    </div>
  )
}

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { format } from 'date-fns'
import { useSession } from 'next-auth/react'
import toast from 'react-hot-toast'
import { Navbar } from '@/components/Navbar'
import { TableSkeleton } from '@/components/LoadingSkeleton'
import { parseDateOnly } from '@/lib/dateOnly'

type Hold = {
  id: string
  truck_number: string
  client_name: string
  market: string
  state: string
  start_date: string
  end_date: string
  status: 'HOLD' | 'COMMITTED' | 'EXPIRED'
  origination: string
  notes: string | null
  created_at: string
  created_by: string
  sfdc_hold_exp: string | null
  user: { name: string; email: string }
}

const STATUS_BADGE: Record<string, string> = {
  HOLD: 'bg-yellow-100 text-yellow-800 border border-yellow-200',
  COMMITTED: 'bg-red-100 text-red-800 border border-red-200',
  EXPIRED: 'bg-gray-100 text-gray-500 border border-gray-200',
}

const ORIGINATION_BADGE: Record<string, string> = {
  frontend: 'bg-gray-100 text-gray-600 border border-gray-200',
  mcp: 'bg-purple-100 text-purple-800 border border-purple-200',
}

type SortKey =
  | 'truck_number' | 'client_name' | 'market' | 'state' | 'start_date' | 'end_date'
  | 'status' | 'origination' | 'created_by_name' | 'created_at'

// Column headers for the desktop table. `key` drives sorting when present;
// Expired/Actions are derived/interactive, not sortable.
const COLUMNS: { label: string; key?: SortKey }[] = [
  { label: 'Truck', key: 'truck_number' },
  { label: 'Client', key: 'client_name' },
  { label: 'Market', key: 'market' },
  { label: 'State', key: 'state' },
  { label: 'Start Date', key: 'start_date' },
  { label: 'End Date', key: 'end_date' },
  { label: 'Status', key: 'status' },
  { label: 'Expired' },
  { label: 'Source', key: 'origination' },
  { label: 'Created By', key: 'created_by_name' },
  { label: 'Created On', key: 'created_at' },
  { label: 'Actions' },
]

function sortValue(hold: Hold, key: SortKey): string | number {
  switch (key) {
    case 'created_at':
      return new Date(hold.created_at).getTime()
    case 'created_by_name':
      return (hold.user?.name ?? '').toLowerCase()
    case 'start_date':
    case 'end_date':
      return hold[key] // ISO strings sort correctly as-is
    default:
      return (hold[key] ?? '').toString().toLowerCase()
  }
}

export default function HoldsPage() {
  const { data: session } = useSession()
  const [holds, setHolds] = useState<Hold[]>([])
  const [loading, setLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [search, setSearch] = useState('')
  const [createdFrom, setCreatedFrom] = useState('') // yyyy-MM-dd, inclusive
  const [createdTo, setCreatedTo] = useState('')     // yyyy-MM-dd, inclusive
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'created_at', dir: 'desc' })
  const [editingHold, setEditingHold] = useState<Hold | null>(null)
  const [editForm, setEditForm] = useState<Partial<Hold>>({})

  const fetchHolds = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/holds')
      if (res.ok) {
        const data = await res.json()
        setHolds(data)
      }
    } catch (err) {
      toast.error('Failed to load holds')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchHolds()
  }, [fetchHolds])

  const handleRelease = async (hold: Hold) => {
    if (!confirm(`Release hold for ${hold.client_name} on truck ${hold.truck_number}?`)) return
    const res = await fetch(`/api/holds/${hold.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success('Hold released')
      fetchHolds()
    } else {
      const err = await res.json()
      toast.error(err.error || 'Failed to release hold')
    }
  }

  const handleUpgrade = async (hold: Hold) => {
    const res = await fetch(`/api/holds/${hold.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'COMMITTED' }),
    })
    if (res.ok) {
      toast.success('Upgraded to Committed')
      fetchHolds()
    } else {
      const err = await res.json()
      toast.error(err.error || 'Failed to upgrade')
    }
  }

  const openEdit = (hold: Hold) => {
    setEditingHold(hold)
    setEditForm({
      client_name: hold.client_name,
      market: hold.market,
      state: hold.state,
      notes: hold.notes || '',
      start_date: hold.start_date.split('T')[0],
      end_date: hold.end_date.split('T')[0],
      status: hold.status,
    })
  }

  const handleEditSave = async () => {
    if (!editingHold) return
    const res = await fetch(`/api/holds/${editingHold.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editForm),
    })
    if (res.ok) {
      toast.success('Hold updated')
      setEditingHold(null)
      fetchHolds()
    } else {
      const err = await res.json()
      toast.error(err.error || 'Failed to update hold')
    }
  }

  const canEdit = (hold: Hold) => {
    if (!session) return false
    if (session.user.role === 'OPERATIONS') return true
    return hold.created_by === session.user.id
  }

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
    )
  }

  const filtered = useMemo(() => {
    let result = filterStatus ? holds.filter((h) => h.status === filterStatus) : holds

    const q = search.trim().toLowerCase()
    if (q) {
      result = result.filter((h) =>
        [h.truck_number, h.client_name, h.market, h.state, h.user?.name, h.notes]
          .filter(Boolean)
          .some((field) => field!.toLowerCase().includes(q))
      )
    }

    if (createdFrom) {
      const from = new Date(createdFrom + 'T00:00:00')
      result = result.filter((h) => new Date(h.created_at) >= from)
    }
    if (createdTo) {
      const to = new Date(createdTo + 'T23:59:59.999')
      result = result.filter((h) => new Date(h.created_at) <= to)
    }

    const dirMultiplier = sort.dir === 'asc' ? 1 : -1
    return [...result].sort((a, b) => {
      const av = sortValue(a, sort.key)
      const bv = sortValue(b, sort.key)
      if (av < bv) return -1 * dirMultiplier
      if (av > bv) return 1 * dirMultiplier
      return 0
    })
  }, [holds, filterStatus, search, createdFrom, createdTo, sort])

  const hasDateFilter = Boolean(createdFrom || createdTo)

  return (
    <div className="flex flex-col min-h-dvh">
      <Navbar />

      <div className="flex-1 p-4 sm:p-6 max-w-7xl mx-auto w-full">
        {/* Header */}
        <div className="flex items-start sm:items-center justify-between mb-4 gap-3">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Holds & Commitments</h1>
            <p className="text-sm text-gray-500 mt-0.5">Manage all truck holds and committed bookings</p>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            {(['', 'HOLD', 'COMMITTED', 'EXPIRED'] as const).map((s) => (
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

        {/* Search + Created On filter */}
        <div className="flex flex-wrap items-center gap-3 mb-4 sm:mb-6">
          <div className="relative max-w-md flex-1 min-w-[240px]">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 104.35 4.35a7.5 7.5 0 0012.3 12.3z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by truck, client, market, state, notes, or created by…"
              className="w-full border border-gray-300 rounded-lg pl-9 pr-8 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 text-sm">
            <span className="text-gray-500 whitespace-nowrap">Created On</span>
            <input
              type="date"
              value={createdFrom}
              onChange={(e) => setCreatedFrom(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <span className="text-gray-400">–</span>
            <input
              type="date"
              value={createdTo}
              onChange={(e) => setCreatedTo(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            {hasDateFilter && (
              <button
                onClick={() => { setCreatedFrom(''); setCreatedTo('') }}
                aria-label="Clear created-on filter"
                className="text-gray-400 hover:text-gray-600 px-1"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <TableSkeleton />
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-gray-400">
            <div className="text-5xl mb-3">📋</div>
            <p className="font-medium">No holds found</p>
            <p className="text-sm mt-1">
              {search || filterStatus || hasDateFilter
                ? 'Try a different search term or filter'
                : 'Place holds from the Schedule Grid on the dashboard'}
            </p>
          </div>
        ) : (
          <>
            {/* ── Mobile: card list ─────────────────────────────────────────── */}
            <div className="sm:hidden space-y-3">
              {filtered.map((hold) => (
                <div key={hold.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
                  {/* Top row: truck + status badge + origination */}
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-lg font-bold text-gray-900">Truck {hold.truck_number}</span>
                    <div className="flex items-center gap-1.5">
                      {hold.origination === 'mcp' && (
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${ORIGINATION_BADGE.mcp}`}>
                          MCP
                        </span>
                      )}
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[hold.status]}`}>
                        {hold.status}
                      </span>
                      {hold.status === 'EXPIRED' && hold.sfdc_hold_exp && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">
                          Expired {format(parseDateOnly(hold.sfdc_hold_exp), 'MMM d')}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Client */}
                  <div className="text-sm font-medium text-gray-800 mb-1">{hold.client_name}</div>

                  {/* Market + State */}
                  <div className="text-sm text-gray-500 mb-2">
                    {[hold.market, hold.state].filter(Boolean).join(', ')}
                  </div>

                  {/* Dates */}
                  <div className="flex items-center gap-2 text-sm text-gray-600 mb-3">
                    <span>{format(parseDateOnly(hold.start_date), 'MMM d, yyyy')}</span>
                    <span className="text-gray-300">→</span>
                    <span>{format(parseDateOnly(hold.end_date), 'MMM d, yyyy')}</span>
                  </div>

                  {/* Footer: created by + actions */}
                  <div className="flex items-center justify-between border-t border-gray-100 pt-3">
                    <span className="text-xs text-gray-400">
                      {hold.user?.name || 'Unknown'} · {format(new Date(hold.created_at), 'MMM d')}
                    </span>
                    {canEdit(hold) && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => openEdit(hold)}
                          className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg transition-colors"
                        >
                          Edit
                        </button>
                        {hold.status === 'HOLD' && (
                          <button
                            onClick={() => handleUpgrade(hold)}
                            className="text-xs bg-red-50 hover:bg-red-100 text-red-700 px-3 py-1.5 rounded-lg transition-colors"
                          >
                            Commit
                          </button>
                        )}
                        {hold.status !== 'EXPIRED' && (
                          <button
                            onClick={() => handleRelease(hold)}
                            className="text-xs bg-red-50 hover:bg-red-100 text-red-700 px-3 py-1.5 rounded-lg transition-colors"
                          >
                            Release
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* ── Desktop: table ────────────────────────────────────────────── */}
            <div className="hidden sm:block bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {COLUMNS.map(({ label, key }) => (
                        <th
                          key={label}
                          onClick={key ? () => toggleSort(key) : undefined}
                          className={`px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide ${
                            key ? 'cursor-pointer select-none hover:text-gray-700' : ''
                          }`}
                        >
                          <span className="inline-flex items-center gap-1">
                            {label}
                            {key && (
                              <span className={`text-[10px] ${sort.key === key ? 'text-gray-700' : 'text-gray-300'}`}>
                                {sort.key === key ? (sort.dir === 'asc' ? '▲' : '▼') : '▲'}
                              </span>
                            )}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filtered.map((hold) => (
                      <tr key={hold.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3 font-semibold text-gray-900">{hold.truck_number}</td>
                        <td className="px-4 py-3 text-gray-700">{hold.client_name}</td>
                        <td className="px-4 py-3 text-gray-600">{hold.market}</td>
                        <td className="px-4 py-3 text-gray-600">{hold.state}</td>
                        <td className="px-4 py-3 text-gray-600">{format(parseDateOnly(hold.start_date), 'MMM d, yyyy')}</td>
                        <td className="px-4 py-3 text-gray-600">{format(parseDateOnly(hold.end_date), 'MMM d, yyyy')}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[hold.status]}`}>
                            {hold.status}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {hold.status === 'EXPIRED' ? (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-500 border border-gray-200">
                              Expired{hold.sfdc_hold_exp ? ` ${format(parseDateOnly(hold.sfdc_hold_exp), 'MMM d')}` : ''}
                            </span>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${ORIGINATION_BADGE[hold.origination] || ORIGINATION_BADGE.frontend}`}>
                            {hold.origination === 'mcp' ? 'MCP' : 'App'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600">{hold.user?.name || 'Unknown'}</td>
                        <td className="px-4 py-3 text-gray-600">{format(new Date(hold.created_at), 'MMM d, yyyy')}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1.5">
                            {canEdit(hold) && (
                              <>
                                <button onClick={() => openEdit(hold)} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-2 py-1 rounded transition-colors">Edit</button>
                                {hold.status === 'HOLD' && (
                                  <button onClick={() => handleUpgrade(hold)} className="text-xs bg-red-50 hover:bg-red-100 text-red-700 px-2 py-1 rounded transition-colors">Commit</button>
                                )}
                                {hold.status !== 'EXPIRED' && (
                                  <button onClick={() => handleRelease(hold)} className="text-xs bg-red-50 hover:bg-red-100 text-red-700 px-2 py-1 rounded transition-colors">Release</button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Edit Modal */}
      {editingHold && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-bold text-gray-900">Edit Hold</h2>
              <p className="text-sm text-gray-500">Truck {editingHold.truck_number}</p>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Client Name
                </label>
                <input
                  type="text"
                  value={editForm.client_name || ''}
                  onChange={(e) => setEditForm({ ...editForm, client_name: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Start Date
                  </label>
                  <input
                    type="date"
                    value={editForm.start_date || ''}
                    onChange={(e) => setEditForm({ ...editForm, start_date: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    End Date
                  </label>
                  <input
                    type="date"
                    value={editForm.end_date || ''}
                    onChange={(e) => setEditForm({ ...editForm, end_date: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                <select
                  value={editForm.status || 'HOLD'}
                  onChange={(e) =>
                    setEditForm({ ...editForm, status: e.target.value as 'HOLD' | 'COMMITTED' })
                  }
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                >
                  <option value="HOLD">HOLD</option>
                  <option value="COMMITTED">COMMITTED</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={editForm.notes || ''}
                  onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                  rows={2}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex gap-3">
              <button
                onClick={() => setEditingHold(null)}
                className="flex-1 border border-gray-300 text-gray-700 rounded-lg py-2 text-sm hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleEditSave}
                className="flex-1 bg-green-700 hover:bg-green-800 text-white rounded-lg py-2 text-sm font-medium"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

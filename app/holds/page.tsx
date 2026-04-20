'use client'

import { useState, useEffect, useCallback } from 'react'
import { format } from 'date-fns'
import { useSession } from 'next-auth/react'
import toast from 'react-hot-toast'
import { Navbar } from '@/components/Navbar'
import { TableSkeleton } from '@/components/LoadingSkeleton'

type Hold = {
  id: string
  truck_number: string
  client_name: string
  market: string
  state: string
  start_date: string
  end_date: string
  status: 'HOLD' | 'COMMITTED'
  notes: string | null
  created_at: string
  created_by: string
  user: { name: string; email: string }
}

const STATUS_BADGE: Record<string, string> = {
  HOLD: 'bg-yellow-100 text-yellow-800 border border-yellow-200',
  COMMITTED: 'bg-red-100 text-red-800 border border-red-200',
}

export default function HoldsPage() {
  const { data: session } = useSession()
  const [holds, setHolds] = useState<Hold[]>([])
  const [loading, setLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState<string>('')
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

  const filtered = filterStatus
    ? holds.filter((h) => h.status === filterStatus)
    : holds

  return (
    <div className="flex flex-col min-h-screen">
      <Navbar />

      <div className="flex-1 p-6 max-w-7xl mx-auto w-full">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Holds & Commitments</h1>
            <p className="text-sm text-gray-500 mt-1">
              Manage all truck holds and committed bookings
            </p>
          </div>
          <div className="flex gap-2">
            {(['', 'HOLD', 'COMMITTED'] as const).map((s) => (
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

        {loading ? (
          <TableSkeleton />
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-gray-400">
            <div className="text-5xl mb-3">📋</div>
            <p className="font-medium">No holds found</p>
            <p className="text-sm mt-1">Place holds from the Schedule Grid on the dashboard</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {[
                      'Truck',
                      'Client',
                      'Market',
                      'State',
                      'Start Date',
                      'End Date',
                      'Status',
                      'Created By',
                      'Actions',
                    ].map((col) => (
                      <th
                        key={col}
                        className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((hold) => (
                    <tr key={hold.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-semibold text-gray-900">
                        {hold.truck_number}
                      </td>
                      <td className="px-4 py-3 text-gray-700">{hold.client_name}</td>
                      <td className="px-4 py-3 text-gray-600">{hold.market}</td>
                      <td className="px-4 py-3 text-gray-600">{hold.state}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {format(new Date(hold.start_date), 'MMM d, yyyy')}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {format(new Date(hold.end_date), 'MMM d, yyyy')}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[hold.status]}`}
                        >
                          {hold.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {hold.user?.name || 'Unknown'}
                        <div className="text-gray-400">
                          {format(new Date(hold.created_at), 'MMM d')}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1.5">
                          {canEdit(hold) && (
                            <>
                              <button
                                onClick={() => openEdit(hold)}
                                className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-2 py-1 rounded transition-colors"
                              >
                                Edit
                              </button>
                              {hold.status === 'HOLD' && (
                                <button
                                  onClick={() => handleUpgrade(hold)}
                                  className="text-xs bg-red-50 hover:bg-red-100 text-red-700 px-2 py-1 rounded transition-colors"
                                >
                                  Commit
                                </button>
                              )}
                              <button
                                onClick={() => handleRelease(hold)}
                                className="text-xs bg-red-50 hover:bg-red-100 text-red-700 px-2 py-1 rounded transition-colors"
                              >
                                Release
                              </button>
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

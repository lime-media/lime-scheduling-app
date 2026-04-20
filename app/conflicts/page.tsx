'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { Navbar } from '@/components/Navbar'

type Conflict = {
  id:                string
  hold_id:           string
  truck_number:      string
  conflict_start:    string
  conflict_end:      string
  hold_client:       string
  hold_market:       string
  scheduled_program: string
  status:            string
  detected_at:       string
}

function relativeTime(iso: string): string {
  const diffMs   = Date.now() - new Date(iso).getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1)  return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHrs = Math.floor(diffMins / 60)
  if (diffHrs < 24)  return `${diffHrs}h ago`
  return `${Math.floor(diffHrs / 24)}d ago`
}

export default function ConflictsPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const [loading,   setLoading]   = useState(true)
  const [acting,    setActing]    = useState<string | null>(null)   // id of row being acted on

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  const fetchConflicts = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/conflicts')
      if (res.ok) {
        const data = await res.json()
        setConflicts(data.conflicts ?? [])
      }
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchConflicts() }, [fetchConflicts])

  const act = async (id: string, action: 'resolve' | 'release-hold') => {
    setActing(id)
    try {
      const res = await fetch(`/api/conflicts/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action }),
      })
      if (res.ok) {
        toast.success(action === 'resolve' ? 'Conflict resolved' : 'Hold released')
        fetchConflicts()
      } else {
        const err = await res.json()
        toast.error(err.error || 'Action failed')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setActing(null)
    }
  }

  if (status === 'loading' || !session) return null

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-gray-50">
      <Navbar />

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-7xl mx-auto">

          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-gray-900">Schedule Conflicts</h1>
              {conflicts.length > 0 && (
                <span className="bg-red-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                  {conflicts.length} Active
                </span>
              )}
            </div>
            <button
              onClick={fetchConflicts}
              className="text-xs text-green-700 hover:text-green-900 font-medium border border-green-300 px-2 py-1 rounded"
            >
              Refresh
            </button>
          </div>

          {/* Table */}
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="w-6 h-6 border-2 border-green-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : conflicts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="text-5xl mb-4">✅</div>
              <p className="text-lg font-semibold text-gray-700">No active conflicts</p>
              <p className="text-sm text-gray-400 mt-1">All holds and schedules are clear</p>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Truck</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Hold Client</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Market</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">LED Program</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Conflict Dates</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Detected</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {conflicts.map((c) => (
                    <tr key={c.id} className="hover:bg-red-50/30 transition-colors">
                      <td className="px-4 py-3 font-semibold text-gray-800">{c.truck_number}</td>
                      <td className="px-4 py-3 text-gray-700">{c.hold_client}</td>
                      <td className="px-4 py-3 text-gray-600">{c.hold_market}</td>
                      <td className="px-4 py-3 text-gray-700">{c.scheduled_program}</td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                        <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded text-xs font-medium">
                          {c.conflict_start} → {c.conflict_end}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                        {relativeTime(c.detected_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <button
                            disabled={acting === c.id}
                            onClick={() => act(c.id, 'resolve')}
                            className="text-xs px-2.5 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40 transition-colors"
                          >
                            Resolve
                          </button>
                          <button
                            disabled={acting === c.id}
                            onClick={() => act(c.id, 'release-hold')}
                            className="text-xs px-2.5 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-40 transition-colors"
                          >
                            Release Hold
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

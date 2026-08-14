'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { ClientHeader } from '@/components/ClientHeader'
import { TableSkeleton } from '@/components/LoadingSkeleton'
import { useClientAuth } from '@/lib/useClientAuth'
import { parseDateOnly } from '@/lib/dateOnly'

type HoldRequest = {
  id: string
  truck_number: string
  market: string
  state: string
  start_date: string
  end_date: string
  notes: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  company_name: string
}

const STATUS_BADGE: Record<string, string> = {
  PENDING:  'bg-purple-100 text-purple-800 border border-purple-200',
  APPROVED: 'bg-green-100 text-green-800 border border-green-200',
  REJECTED: 'bg-red-100 text-red-800 border border-red-200',
}

export default function ClientHoldRequestsPage() {
  const { clientUser, authChecked } = useClientAuth()

  const [requests,     setRequests]     = useState<HoldRequest[]>([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [filterStatus, setFilterStatus] = useState<string>('')

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
    if (authChecked && clientUser) fetchRequests()
    else if (authChecked) setLoading(false)
  }, [authChecked, clientUser, fetchRequests])

  const filtered = filterStatus ? requests.filter((r) => r.status === filterStatus) : requests

  return (
    <div className="flex flex-col h-dvh overflow-hidden">
      <ClientHeader clientUser={clientUser} authChecked={authChecked} />

      <div className="flex-1 overflow-auto p-4 sm:p-6 max-w-5xl mx-auto w-full">
        {!authChecked ? (
          <TableSkeleton />
        ) : !clientUser ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <div className="text-5xl mb-4">🔒</div>
            <p className="text-gray-600 font-medium">Log in to view your hold requests</p>
            <Link href="/client/login" className="mt-4 bg-[#1a3028] text-white px-4 py-2 rounded-lg text-sm hover:bg-[#1a3028]/90">
              Log in
            </Link>
          </div>
        ) : clientUser.username !== 'testclient' ? (
          // Staged rollout — see app/api/client/chat/route.ts
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <div className="text-5xl mb-4">🚧</div>
            <p className="text-gray-600 font-medium">This page isn't available on your account yet.</p>
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
              <div className="flex gap-2 flex-shrink-0">
                {(['', 'PENDING', 'APPROVED', 'REJECTED'] as const).map((s) => (
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
                <div className="text-5xl mb-4">⚠️</div>
                <p className="text-gray-600 font-medium">{error}</p>
                <button onClick={fetchRequests} className="mt-4 bg-green-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-800">Retry</button>
              </div>
            ) : loading ? (
              <TableSkeleton />
            ) : filtered.length === 0 ? (
              <div className="text-center py-20 text-gray-400">
                <div className="text-5xl mb-3">📋</div>
                <p className="font-medium">No hold requests found</p>
                <p className="text-sm mt-1">Drag on an available cell in the Schedule Grid to submit one</p>
              </div>
            ) : (
              <>
                {/* ── Mobile: card list ─────────────────────────────────────────── */}
                <div className="sm:hidden space-y-3">
                  {filtered.map((r) => (
                    <div key={r.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-lg font-bold text-gray-900">Truck {r.truck_number}</span>
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[r.status]}`}>
                          {r.status}
                        </span>
                      </div>
                      <div className="text-sm text-gray-500 mb-2">{[r.market, r.state].filter(Boolean).join(', ')}</div>
                      <div className="flex items-center gap-2 text-sm text-gray-600 mb-2">
                        <span>{format(parseDateOnly(r.start_date), 'MMM d, yyyy')}</span>
                        <span className="text-gray-300">→</span>
                        <span>{format(parseDateOnly(r.end_date), 'MMM d, yyyy')}</span>
                      </div>
                      {r.notes && <div className="text-xs text-gray-500 border-t border-gray-100 pt-2 mt-1">{r.notes}</div>}
                    </div>
                  ))}
                </div>

                {/* ── Desktop: table ────────────────────────────────────────────── */}
                <div className="hidden sm:block bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          {['Truck', 'Market', 'State', 'Start Date', 'End Date', 'Status', 'Notes'].map((col) => (
                            <th key={col} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {filtered.map((r) => (
                          <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                            <td className="px-4 py-3 font-semibold text-gray-900">{r.truck_number}</td>
                            <td className="px-4 py-3 text-gray-600">{r.market}</td>
                            <td className="px-4 py-3 text-gray-600">{r.state}</td>
                            <td className="px-4 py-3 text-gray-600">{format(parseDateOnly(r.start_date), 'MMM d, yyyy')}</td>
                            <td className="px-4 py-3 text-gray-600">{format(parseDateOnly(r.end_date), 'MMM d, yyyy')}</td>
                            <td className="px-4 py-3">
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[r.status]}`}>
                                {r.status}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-gray-500 text-xs max-w-xs truncate">{r.notes || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

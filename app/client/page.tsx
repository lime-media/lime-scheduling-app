'use client'

import { useState, useEffect, useCallback } from 'react'
import { format, addDays, startOfDay, parseISO } from 'date-fns'
import { ScheduleGrid, type TruckInfo, type ScheduleBlock, type HoldBlock, type HoldRequestBlock } from '@/components/ScheduleGrid'
import { FilterBar } from '@/components/FilterBar'
import { ClientHeader } from '@/components/ClientHeader'
import { ScheduleSkeleton } from '@/components/LoadingSkeleton'
import { useClientAuth } from '@/lib/useClientAuth'

type Filters = {
  state: string
  market: string
  statusFilters: Set<string>
  dateFrom: string
  dateTo: string
}

type HoldRequestDraft = {
  truckNum: string
  start: string
  end: string
  market: string
}

const today = startOfDay(new Date())
const DEFAULT_RANGE_DAYS = 63 // 9 weeks
const FIREFLY_RANGE_DAYS = 14 // 2 weeks — Firefly is restricted to a shorter lookahead

function isFirefly(companyName: string | undefined | null): boolean {
  return (companyName ?? '').trim().toLowerCase() === 'firefly'
}

const defaultFilters: Filters = {
  state: '',
  market: '',
  statusFilters: new Set(),
  dateFrom: format(today, 'yyyy-MM-dd'),
  dateTo: format(addDays(today, DEFAULT_RANGE_DAYS), 'yyyy-MM-dd'),
}

export default function ClientPage() {
  const { clientUser, authChecked } = useClientAuth()

  const [trucks,        setTrucks]        = useState<TruckInfo[]>([])
  const [schedules,     setSchedules]     = useState<ScheduleBlock[]>([])
  const [holdBlocks,    setHoldBlocks]    = useState<HoldBlock[]>([])
  const [holdRequests,  setHoldRequests]  = useState<HoldRequestBlock[]>([])
  const [markets,       setMarkets]       = useState<string[]>([])
  const [states,        setStates]        = useState<string[]>([])
  const [filters,       setFilters]       = useState<Filters>(defaultFilters)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState('')

  // Hold request draft (from drag)
  const [draft,         setDraft]         = useState<HoldRequestDraft | null>(null)
  const [draftNotes,    setDraftNotes]    = useState('')
  const [draftLoading,  setDraftLoading]  = useState(false)
  const [draftError,    setDraftError]    = useState('')

  // Firefly clients get a shorter default lookahead window
  useEffect(() => {
    if (isFirefly(clientUser?.companyName)) {
      setFilters((f) => ({ ...f, dateTo: format(addDays(today, FIREFLY_RANGE_DAYS), 'yyyy-MM-dd') }))
    }
  }, [clientUser])

  const fetchHoldRequests = useCallback(async () => {
    if (!clientUser) return
    try {
      const res  = await fetch('/api/client/hold-requests')
      if (!res.ok) return
      const data = await res.json()
      setHoldRequests(data.holdRequests || [])
    } catch { /* non-fatal */ }
  }, [clientUser])

  const fetchSchedule = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/client/schedule')
      if (!res.ok) throw new Error('Failed to fetch schedule')
      const data = await res.json()
      const schedulesData: ScheduleBlock[] = data.schedules || []
      setTrucks(data.trucks       || [])
      setSchedules(schedulesData)
      setHoldBlocks(data.holds    || [])
      setMarkets(data.markets?.length ? data.markets : [...new Set(schedulesData.map((s: ScheduleBlock) => s.standard_market_name || s.market).filter(Boolean))].sort())
      setStates([...new Set(schedulesData.map((s) => s.state).filter(Boolean))].sort())
    } catch {
      setError('Unable to load availability. Please try again later.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSchedule() }, [fetchSchedule])
  useEffect(() => { fetchHoldRequests() }, [fetchHoldRequests])

  const handleCellRangeSelected = (truckNum: string, start: string, end: string, market: string) => {
    setDraft({ truckNum, start, end, market })
    setDraftNotes('')
    setDraftError('')
  }

  const handleDraftSubmit = async () => {
    if (!draft) return
    setDraftLoading(true)
    setDraftError('')
    try {
      const res = await fetch('/api/client/hold-requests', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          truck_number: draft.truckNum,
          market:       draft.market,
          start_date:   draft.start,
          end_date:     draft.end,
          notes:        draftNotes || null,
        }),
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setDraft(null)
      // Optimistically add immediately so cells turn purple without waiting for refetch
      setHoldRequests((prev) => [
        ...prev,
        {
          id:           data.id,
          truck_number: draft.truckNum,
          market:       draft.market,
          state:        '',
          start_date:   draft.start,
          end_date:     draft.end,
          notes:        draftNotes || '',
          status:       'PENDING' as const,
          company_name: clientUser?.companyName || '',
        },
      ])
      fetchHoldRequests()
    } catch {
      setDraftError('Failed to submit. Please try again.')
    } finally {
      setDraftLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-dvh overflow-hidden">
      <ClientHeader clientUser={clientUser} authChecked={authChecked} />

      <div className="flex-1 flex flex-col overflow-hidden p-4 min-w-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-lg font-bold text-gray-900">Schedule Grid</h1>
            {authChecked && clientUser && (
              <p className="text-xs text-purple-600 mt-0.5">Drag on available cells to submit a hold request.</p>
            )}
          </div>
          {!loading && <span className="text-xs text-gray-400">{trucks.length} trucks</span>}
        </div>

        <FilterBar
          filters={filters}
          onChange={setFilters}
          markets={markets}
          clientView
          rangeDays={isFirefly(clientUser?.companyName) ? FIREFLY_RANGE_DAYS : DEFAULT_RANGE_DAYS}
        />

        <div className="flex-1 overflow-auto mt-3">
          {error ? (
            <div className="flex flex-col items-center justify-center h-64 text-center">
              <div className="text-5xl mb-4">⚠️</div>
              <p className="text-gray-600 font-medium">{error}</p>
              <button onClick={fetchSchedule} className="mt-4 bg-green-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-800">Retry</button>
            </div>
          ) : loading ? (
            <ScheduleSkeleton />
          ) : (
            <div className="min-w-[900px]">
              <ScheduleGrid
                trucks={trucks}
                schedules={schedules}
                holds={holdBlocks}
                holdRequests={holdRequests}
                filters={filters}
                onHoldCreated={() => {}}
                onCellRangeSelected={clientUser ? handleCellRangeSelected : undefined}
                markets={markets}
                states={states}
                clientView
              />
            </div>
          )}
        </div>
      </div>

      {/* Hold request modal */}
      {draft && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-bold text-gray-900 mb-1">Submit Hold Request</h2>
            <p className="text-sm text-gray-500 mb-4">Your request will be sent to the Lime Media team for review.</p>

            <div className="space-y-2 text-sm mb-4">
              <div className="flex justify-between"><span className="text-gray-500">Truck</span><span className="font-medium">{draft.truckNum}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Market</span><span className="font-medium">{draft.market || '—'}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Dates</span><span className="font-medium">{format(parseISO(draft.start), 'MMM d')} – {format(parseISO(draft.end), 'MMM d, yyyy')}</span></div>
            </div>

            <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
            <textarea
              value={draftNotes}
              onChange={(e) => setDraftNotes(e.target.value)}
              rows={3}
              placeholder="Any additional details…"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
            />

            {draftError && <p className="text-xs text-red-600 mt-2">{draftError}</p>}

            <div className="flex gap-2 mt-4">
              <button onClick={() => setDraft(null)} className="flex-1 border border-gray-300 text-gray-600 py-2 rounded text-sm hover:bg-gray-50">Cancel</button>
              <button onClick={handleDraftSubmit} disabled={draftLoading} className="flex-1 bg-purple-600 text-white py-2 rounded text-sm font-medium hover:bg-purple-700 disabled:opacity-50">
                {draftLoading ? 'Submitting…' : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

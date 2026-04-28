'use client'

import { useState, useEffect, useCallback } from 'react'
import { format, addDays, startOfDay } from 'date-fns'
import Link from 'next/link'
import { Navbar } from '@/components/Navbar'
import { ScheduleGrid, type TruckInfo, type ScheduleBlock, type HoldBlock } from '@/components/ScheduleGrid'
import { FilterBar } from '@/components/FilterBar'
import { ScheduleSkeleton } from '@/components/LoadingSkeleton'

type Filters = {
  state: string
  market: string
  statusFilters: Set<string>
  dateFrom: string
  dateTo: string
}

const today = startOfDay(new Date())

const defaultFilters: Filters = {
  state: '',
  market: '',
  statusFilters: new Set(),
  dateFrom: format(addDays(today, -7), 'yyyy-MM-dd'),
  dateTo: format(addDays(today, 90), 'yyyy-MM-dd'),
}

export default function DashboardPage() {
  const [trucks,    setTrucks]    = useState<TruckInfo[]>([])
  const [schedules, setSchedules] = useState<ScheduleBlock[]>([])
  const [holdBlocks, setHoldBlocks] = useState<HoldBlock[]>([])
  const [markets, setMarkets] = useState<string[]>([])
  const [states,  setStates]  = useState<string[]>([])
  const [filters, setFilters] = useState<Filters>(defaultFilters)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchSchedule = useCallback(async (force = false) => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(force ? '/api/schedule?force=1' : '/api/schedule')
      if (!res.ok) throw new Error('Failed to fetch schedule')
      const data = await res.json()
      setTrucks(data.trucks       || [])
      setSchedules(data.schedules || [])
      setHoldBlocks(data.holds    || [])
    } catch (err) {
      setError('Failed to load schedule data. Check your database connection.')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchMarkets = useCallback(async () => {
    try {
      const res = await fetch('/api/markets')
      if (res.ok) {
        const data = await res.json()
        setMarkets(data.markets ?? [])
        setStates(data.states   ?? [])
      }
    } catch (err) {
      console.error('Failed to fetch markets:', err)
    }
  }, [])

  useEffect(() => {
    const init = async () => {
      await Promise.all([fetchSchedule(), fetchMarkets()])
      // Auto-create ATT soft holds for next month; refresh grid if any were created
      try {
        const r = await fetch('/api/holds/att-sync', { method: 'POST' })
        if (r.ok) {
          const data = await r.json()
          if (data.created > 0) fetchSchedule()
        }
      } catch {
        // Non-critical — grid still works without ATT sync
      }
    }
    init()
  }, [fetchSchedule, fetchMarkets])

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <Navbar />

      <div className="flex-1 flex overflow-hidden relative">
        {/* Schedule panel — full width */}
        <div className="flex-1 flex flex-col overflow-hidden p-4 min-w-0">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-bold text-gray-900">Schedule Grid</h1>
            <div className="flex items-center gap-2">
              {!loading && (
                <span className="text-xs text-gray-400">
                  {trucks.length} trucks
                </span>
              )}
              <button
                onClick={() => fetchSchedule(true)}
                className="text-xs text-green-700 hover:text-green-900 font-medium border border-green-300 px-2 py-1 rounded"
              >
                Refresh
              </button>
            </div>
          </div>

          <FilterBar
            filters={filters}
            onChange={setFilters}
            states={states}
            markets={markets}
          />


          <div className="flex-1 overflow-auto mt-3">
            {error ? (
              <div className="flex flex-col items-center justify-center h-64 text-center">
                <div className="text-5xl mb-4">⚠️</div>
                <p className="text-gray-600 font-medium">{error}</p>
                <button
                  onClick={() => fetchSchedule(true)}
                  className="mt-4 bg-green-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-800"
                >
                  Retry
                </button>
              </div>
            ) : loading ? (
              <ScheduleSkeleton />
            ) : (
              <ScheduleGrid
                trucks={trucks}
                schedules={schedules}
                holds={holdBlocks}
                filters={filters}
                onHoldCreated={fetchSchedule}
                markets={markets}
                states={states}
              />
            )}
          </div>
        </div>

        {/* Floating AI button */}
        <Link
          href="/ai"
          title="Ask AI Assistant"
          className="fixed bottom-6 right-6 z-50 w-12 h-12 bg-green-700 hover:bg-green-800 text-white rounded-full shadow-lg flex items-center justify-center transition-colors group"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          <span className="absolute right-14 bg-gray-800 text-white text-xs px-2 py-1 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            Ask AI Assistant
          </span>
        </Link>
      </div>
    </div>
  )
}

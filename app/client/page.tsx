'use client'

import { useState, useEffect, useCallback } from 'react'
import { format, addDays, startOfDay } from 'date-fns'
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

export default function ClientPage() {
  const [trucks,     setTrucks]     = useState<TruckInfo[]>([])
  const [schedules,  setSchedules]  = useState<ScheduleBlock[]>([])
  const [holdBlocks, setHoldBlocks] = useState<HoldBlock[]>([])
  const [markets,    setMarkets]    = useState<string[]>([])
  const [states,     setStates]     = useState<string[]>([])
  const [filters,    setFilters]    = useState<Filters>(defaultFilters)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')

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
      // Derive markets and states from schedule data — no separate auth'd API call needed
      setMarkets([...new Set(schedulesData.map((s) => s.standard_market_name || s.market).filter(Boolean))].sort())
      setStates([...new Set(schedulesData.map((s) => s.state).filter(Boolean))].sort())
    } catch {
      setError('Unable to load availability. Please try again later.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSchedule()
  }, [fetchSchedule])

  return (
    <div className="flex flex-col h-dvh overflow-hidden">
      <header className="bg-[#1a3028] text-white shadow-lg px-4 sm:px-6 py-3 flex items-center justify-between flex-shrink-0">
        <img src="/logo.png" alt="Lime Media" className="h-9 w-auto" />
        <span className="text-sm text-green-200 font-medium">Truck Availability</span>
      </header>

      <div className="flex-1 flex flex-col overflow-hidden p-4 min-w-0">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-bold text-gray-900">Schedule Grid</h1>
          {!loading && (
            <span className="text-xs text-gray-400">{trucks.length} trucks</span>
          )}
        </div>

        <FilterBar
          filters={filters}
          onChange={setFilters}
          states={states}
          markets={markets}
          clientView
        />

        <div className="flex-1 overflow-auto mt-3">
          {error ? (
            <div className="flex flex-col items-center justify-center h-64 text-center">
              <div className="text-5xl mb-4">⚠️</div>
              <p className="text-gray-600 font-medium">{error}</p>
              <button
                onClick={fetchSchedule}
                className="mt-4 bg-green-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-800"
              >
                Retry
              </button>
            </div>
          ) : loading ? (
            <ScheduleSkeleton />
          ) : (
            <div className="min-w-[900px]">
              <ScheduleGrid
                trucks={trucks}
                schedules={schedules}
                holds={holdBlocks}
                filters={filters}
                onHoldCreated={() => {}}
                markets={markets}
                states={states}
                clientView
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

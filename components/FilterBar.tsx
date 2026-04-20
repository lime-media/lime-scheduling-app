'use client'

import { format, addDays, startOfDay } from 'date-fns'

type Filters = {
  state: string
  market: string
  statusFilters: Set<string>
  dateFrom: string
  dateTo: string
}

interface FilterBarProps {
  filters: Filters
  onChange: (filters: Filters) => void
  states: string[]
  markets: string[]
}

const STATUS_OPTIONS = [
  { value: 'EMPTY',             label: 'Available',  color: 'bg-gray-400' },
  { value: 'SCHEDULED_LED',     label: 'Scheduled',  color: 'bg-green-500' },
  { value: 'HOLD_TENTATIVE',    label: 'On Hold',    color: 'bg-yellow-400' },
  { value: 'COMMITTED_NOT_SET', label: 'Committed',  color: 'bg-red-500' },
]

export function FilterBar({ filters, onChange, states, markets }: FilterBarProps) {
  const today = startOfDay(new Date())

  const toggleStatus = (status: string) => {
    const next = new Set(filters.statusFilters)
    if (next.has(status)) next.delete(status)
    else next.add(status)
    onChange({ ...filters, statusFilters: next })
  }

  const reset = () => {
    onChange({
      state: '',
      market: '',
      statusFilters: new Set(),
      dateFrom: format(addDays(today, -7), 'yyyy-MM-dd'),
      dateTo: format(addDays(today, 90), 'yyyy-MM-dd'),
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-3 pb-3 border-b border-gray-200">
      {/* State filter */}
      <div className="flex items-center gap-1.5">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">State</label>
        <select
          value={filters.state}
          onChange={(e) =>
            onChange({ ...filters, state: e.target.value, market: '' })
          }
          className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
        >
          <option value="">All states</option>
          {states.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {/* Market filter */}
      <div className="flex items-center gap-1.5">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Market</label>
        <select
          value={filters.market}
          onChange={(e) => onChange({ ...filters, market: e.target.value })}
          className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
        >
          <option value="">All markets</option>
          {markets.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {/* Date range */}
      <div className="flex items-center gap-1.5">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">From</label>
        <input
          type="date"
          value={filters.dateFrom}
          onChange={(e) => onChange({ ...filters, dateFrom: e.target.value })}
          className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
        />
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">To</label>
        <input
          type="date"
          value={filters.dateTo}
          onChange={(e) => onChange({ ...filters, dateTo: e.target.value })}
          className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
        />
      </div>

      {/* Status toggles */}
      <div className="flex items-center gap-1.5">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Status</label>
        <div className="flex gap-1">
          {STATUS_OPTIONS.map((opt) => {
            const active = filters.statusFilters.has(opt.value)
            return (
              <button
                key={opt.value}
                onClick={() => toggleStatus(opt.value)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border transition-all ${
                  active
                    ? 'border-gray-400 bg-gray-100 text-gray-800 shadow-inner'
                    : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
                }`}
                title={`Filter by ${opt.label}`}
              >
                <span className={`w-2.5 h-2.5 rounded-full ${opt.color}`} />
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Reset */}
      <button
        onClick={reset}
        className="ml-auto text-xs text-gray-500 hover:text-gray-700 underline"
      >
        Reset filters
      </button>
    </div>
  )
}

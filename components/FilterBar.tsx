'use client'

import { format, addDays, startOfDay } from 'date-fns'
import { US_STATE_NAMES } from '@/lib/usStates'
import { SearchableSelect } from '@/components/SearchableSelect'

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
  clientView?: boolean
}

const STATUS_OPTIONS = [
  { value: 'EMPTY',             label: 'Available',    color: 'bg-gray-400' },
  { value: 'SCHEDULED_LED',     label: 'Scheduled',    color: 'bg-green-500' },
  { value: 'MAINTENANCE',       label: 'Maintenance',  color: 'bg-orange-400' },
  { value: 'HOLD_TENTATIVE',    label: 'On Hold',      color: 'bg-yellow-400' },
  { value: 'COMMITTED_NOT_SET', label: 'Committed',    color: 'bg-red-500' },
  { value: 'ATT_SOFT',          label: 'ATT Hold',     color: 'bg-blue-400' },
  { value: 'HOLD_REQUEST',      label: 'Requested',    color: 'bg-yellow-400' },
]

const BOOKED_STATUSES = ['SCHEDULED_LED', 'MAINTENANCE', 'HOLD_TENTATIVE', 'ATT_SOFT', 'COMMITTED_NOT_SET']

export function FilterBar({ filters, onChange, states, markets, clientView = false }: FilterBarProps) {
  const today = startOfDay(new Date())

  const toggleStatus = (status: string) => {
    const next = new Set(filters.statusFilters)
    if (next.has(status)) next.delete(status)
    else next.add(status)
    onChange({ ...filters, statusFilters: next })
  }

  const toggleBooked = () => {
    const next = new Set(filters.statusFilters)
    const anyActive = BOOKED_STATUSES.some((s) => next.has(s))
    if (anyActive) BOOKED_STATUSES.forEach((s) => next.delete(s))
    else BOOKED_STATUSES.forEach((s) => next.add(s))
    onChange({ ...filters, statusFilters: next })
  }

  const reset = () => {
    onChange({
      state: '',
      market: '',
      statusFilters: new Set(),
      dateFrom: format(today, 'yyyy-MM-dd'),
      dateTo: format(addDays(today, 14), 'yyyy-MM-dd'),
    })
  }

  return (
    <div className="flex flex-col gap-2 pb-3 border-b border-gray-200">
      {/* Row 1: State + Market */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* State filter */}
        <div className="flex items-center gap-1.5">
          <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">State</label>
          <SearchableSelect
            value={filters.state}
            options={states}
            placeholder="All states"
            width="w-24"
            getAliasText={(abbr) => US_STATE_NAMES[abbr]}
            onChange={(s) => onChange({ ...filters, state: s, market: '' })}
          />
        </div>

        {/* Market filter */}
        <div className="flex items-center gap-1.5">
          <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Market</label>
          <SearchableSelect
            value={filters.market}
            options={markets}
            placeholder="All markets"
            onChange={(m) => onChange({ ...filters, market: m })}
          />
        </div>
      </div>

      {/* Row 2: Status toggles + Reset */}
      <div className="flex items-start gap-1.5 flex-wrap">
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide mt-1.5 flex-shrink-0">Status</label>
        <div className="flex flex-wrap gap-1 flex-1">
          {clientView ? (
            <>
              {[
                { label: 'Available', color: 'bg-green-500', active: filters.statusFilters.has('EMPTY'), onClick: () => toggleStatus('EMPTY') },
                { label: 'Booked',    color: 'bg-gray-400',  active: BOOKED_STATUSES.some((s) => filters.statusFilters.has(s)), onClick: toggleBooked },
              ].map((opt) => (
                <button
                  key={opt.label}
                  onClick={opt.onClick}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border transition-all ${
                    opt.active
                      ? 'border-gray-400 bg-gray-100 text-gray-800 shadow-inner'
                      : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${opt.color}`} />
                  {opt.label}
                </button>
              ))}
            </>
          ) : (
            STATUS_OPTIONS.map((opt) => {
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
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${opt.color}`} />
                  {opt.label}
                </button>
              )
            })
          )}
        </div>
        <button
          onClick={reset}
          className="text-xs text-gray-500 hover:text-gray-700 underline flex-shrink-0 mt-1.5"
        >
          Reset filters
        </button>
      </div>
    </div>
  )
}

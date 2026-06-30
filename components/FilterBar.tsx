'use client'

import { useState, useRef, useEffect } from 'react'
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
  clientView?: boolean
}

const STATUS_OPTIONS = [
  { value: 'EMPTY',             label: 'Available',    color: 'bg-gray-400' },
  { value: 'SCHEDULED_LED',     label: 'Scheduled',    color: 'bg-green-500' },
  { value: 'MAINTENANCE',       label: 'Maintenance',  color: 'bg-orange-400' },
  { value: 'HOLD_TENTATIVE',    label: 'On Hold',      color: 'bg-yellow-400' },
  { value: 'COMMITTED_NOT_SET', label: 'Committed',    color: 'bg-red-500' },
  { value: 'ATT_SOFT',          label: 'ATT Hold',     color: 'bg-blue-400' },
]

const BOOKED_STATUSES = ['SCHEDULED_LED', 'MAINTENANCE', 'HOLD_TENTATIVE', 'ATT_SOFT', 'COMMITTED_NOT_SET']

function SearchableSelect({
  value,
  options,
  placeholder,
  onChange,
  width = 'w-40',
}: {
  value: string
  options: string[]
  placeholder: string
  onChange: (v: string) => void
  width?: string
}) {
  const [open, setOpen]   = useState(false)
  const [query, setQuery] = useState('')
  const containerRef      = useRef<HTMLDivElement>(null)
  const inputRef          = useRef<HTMLInputElement>(null)

  const filtered = query
    ? options.filter((o) => o.toLowerCase().includes(query.toLowerCase()))
    : options

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const select = (v: string) => {
    onChange(v)
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={containerRef} className="relative">
      <div
        className="flex items-center border border-gray-300 rounded bg-white text-sm focus-within:ring-2 focus-within:ring-green-500 cursor-text"
        onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0) }}
      >
        {open ? (
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={value || `Search…`}
            className={`px-2 py-1 outline-none bg-transparent ${width} text-gray-800 placeholder-gray-400`}
          />
        ) : (
          <span className={`px-2 py-1 ${width} truncate ${value ? 'text-gray-800' : 'text-gray-400'}`}>
            {value || placeholder}
          </span>
        )}
        {value && !open && (
          <button
            onClick={(e) => { e.stopPropagation(); onChange('') }}
            className="pr-1.5 text-gray-400 hover:text-gray-600"
          >✕</button>
        )}
        {!value && (
          <span className="pr-2 text-gray-400 pointer-events-none">▾</span>
        )}
      </div>

      {open && (
        <ul className="absolute z-50 mt-1 max-h-60 w-48 overflow-auto rounded border border-gray-200 bg-white shadow-lg text-sm">
          <li
            onMouseDown={() => select('')}
            className="px-3 py-1.5 cursor-pointer text-gray-400 hover:bg-gray-50"
          >
            {placeholder}
          </li>
          {filtered.length === 0 ? (
            <li className="px-3 py-1.5 text-gray-400">No results</li>
          ) : (
            filtered.map((o) => (
              <li
                key={o}
                onMouseDown={() => select(o)}
                className={`px-3 py-1.5 cursor-pointer hover:bg-green-50 ${o === value ? 'bg-green-50 font-medium text-green-800' : 'text-gray-800'}`}
              >
                {o}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}

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

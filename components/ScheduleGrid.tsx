'use client'

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { format, addDays, startOfDay, parseISO, isSameDay } from 'date-fns'
import toast from 'react-hot-toast'
import { HoldModal } from './HoldModal'
import { CellDetail } from './CellDetail'

// ── Exported data types (match API response) ──────────────────────────────────

export type TruckInfo = {
  truck_number:      string
  last_gps:          string        // full address string, e.g. "Street, City, ST, ZIP"
  last_known_market: string | null // market of most recent schedule block (any date)
  last_known_state:  string | null // state of most recent schedule block (any date)
}

export type ScheduleBlock = {
  truck_number: string
  market: string
  standard_market_name?: string
  state: string
  program: string
  shift_start: string        // YYYY-MM-DD
  shift_end: string          // YYYY-MM-DD
}

export type HoldBlock = {
  id: string
  truck_number: string
  client_name: string
  market: string
  state: string
  notes: string
  start_date: string         // YYYY-MM-DD
  end_date: string           // YYYY-MM-DD
  status: 'HOLD' | 'COMMITTED' | 'ATT_SOFT'
  created_by: string
  user_name: string | null
}

// ── Internal synthesised row type (used by CellDetail / HoldModal) ────────────

export type ScheduleRow = {
  truck_number: string
  market: string
  state: string
  program: string
  formatted_location: string
  display_status: 'EMPTY' | 'SCHEDULED_LED' | 'HOLD_TENTATIVE' | 'COMMITTED_NOT_SET' | 'ATT_SOFT' | 'MAINTENANCE'
  calendar_date: string
  shift_start: string | null
  shift_end: string | null
  last_known_market?: string
  last_gps_state?: string
  standard_market_name?: string
  hold_id?: string
  client_name?: string
  hold_market?: string
  hold_state?: string
  hold_notes?: string
  hold_created_by?: string
  /** Set when a hold and a schedule block occupy the same cell — conflict indicator */
  conflictProgram?: string
}

type Filters = {
  state: string
  market: string
  statusFilters: Set<string>
  dateFrom: string
  dateTo: string
}

const STATUS_COLORS: Record<string, string> = {
  EMPTY:              'bg-gray-200 hover:bg-gray-300',
  SCHEDULED_LED:      'bg-green-500 hover:bg-green-600',
  HOLD_TENTATIVE:     'bg-yellow-400 hover:bg-yellow-500',
  COMMITTED_NOT_SET:  'bg-red-500 hover:bg-red-600',
  ATT_SOFT:           'bg-blue-400 hover:bg-blue-500',
  MAINTENANCE:        'bg-orange-400 hover:bg-orange-500',
}

const STATUS_BORDER: Record<string, string> = {
  EMPTY:              'border-gray-300',
  SCHEDULED_LED:      'border-green-600',
  HOLD_TENTATIVE:     'border-yellow-500',
  COMMITTED_NOT_SET:  'border-red-600',
  ATT_SOFT:           'border-blue-500',
  MAINTENANCE:        'border-orange-500',
}

const STATUS_LABELS: Record<string, string> = {
  EMPTY:              'Available',
  SCHEDULED_LED:      'Scheduled',
  HOLD_TENTATIVE:     'On Hold',
  COMMITTED_NOT_SET:  'Committed',
  ATT_SOFT:           'ATT Hold',
  MAINTENANCE:        'Maintenance',
}

function getDates(from: Date, to: Date): Date[] {
  const dates: Date[] = []
  let current = startOfDay(from)
  while (current <= to) {
    dates.push(current)
    current = addDays(current, 1)
  }
  return dates
}


// Extract state from "Street, City, ST, ZIP" — 3rd comma-separated segment (index 2).
function extractState(address: string): string {
  return address?.split(',')[2]?.trim() ?? ''
}

interface ScheduleGridProps {
  trucks: TruckInfo[]
  schedules: ScheduleBlock[]
  holds: HoldBlock[]
  filters: Filters
  onHoldCreated: () => void
  markets: string[]
  states: string[]
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function ScheduleGrid({ trucks, schedules, holds, filters, onHoldCreated, markets, states: _states }: ScheduleGridProps) {
  const today = startOfDay(new Date())
  const dateFrom = filters.dateFrom ? startOfDay(parseISO(filters.dateFrom)) : addDays(today, -7)
  const dateTo   = filters.dateTo   ? startOfDay(parseISO(filters.dateTo))   : addDays(today, 90)
  const dates = getDates(dateFrom, dateTo)

  const [selectedCell, setSelectedCell] = useState<ScheduleRow | null>(null)
  const [dragStart, setDragStart] = useState<{ truck: string; dateIdx: number } | null>(null)
  const [dragEnd,   setDragEnd]   = useState<{ truck: string; dateIdx: number } | null>(null)
  const [showHoldModal, setShowHoldModal] = useState(false)
  const [holdRange, setHoldRange] = useState<{ truck: string; start: Date; end: Date } | null>(null)

  const isDragging  = useRef(false)
  const hasMoved    = useRef(false)
  const pendingCell = useRef<ScheduleRow | null>(null)

  // ── Per-truck derived data ────────────────────────────────────────────────
  // Computed once when trucks/schedules change. Avoids per-cell recalculation.
  //
  // last_gps_state      = address.split(',')[2].trim()  (index 2 of "Street, City, ST, ZIP")
  // last_schedule_state = state field of the most recent schedule block (any date)
  // last_known_market   = market of the most recent schedule block with shift_start ≤ today

  const truckMeta = useMemo(() => {
    const todayStr = format(startOfDay(new Date()), 'yyyy-MM-dd')

    const meta = new Map<string, {
      last_gps:            string
      last_gps_state:      string
      last_schedule_state: string
      last_known_market:   string
      _bestSchedStart:     string  // internal: max shift_start for last_known_market
      _bestStateStart:     string  // internal: max shift_start for last_schedule_state
    }>()

    for (const t of trucks) {
      meta.set(t.truck_number, {
        last_gps:            t.last_gps,
        last_gps_state:      extractState(t.last_gps),
        last_schedule_state: '',
        last_known_market:   '',
        _bestSchedStart:     '',
        _bestStateStart:     '',
      })
    }

    for (const block of schedules) {
      if (!block.shift_start) continue
      const entry = meta.get(block.truck_number)
      if (!entry) continue

      // last_schedule_state: most recent block overall (no date constraint)
      if (block.shift_start >= entry._bestStateStart) {
        entry._bestStateStart     = block.shift_start
        entry.last_schedule_state = block.state
      }

      // last_known_market: most recent block with shift_start ≤ today; prefer standard market name
      if (block.shift_start <= todayStr && block.shift_start >= entry._bestSchedStart) {
        entry._bestSchedStart   = block.shift_start
        entry.last_known_market = block.standard_market_name || block.market
      }
    }

    return meta
  }, [trucks, schedules])

  // ── Day-level lookup map ──────────────────────────────────────────────────
  // "truck__YYYY-MM-DD" → { sched?, hold? }
  // Holds are layered on top of schedules; holds take priority in getCellData.

  const dataMap = useMemo(() => {
    const m = new Map<string, { sched?: ScheduleBlock; hold?: HoldBlock; attHold?: HoldBlock }>()

    for (const block of schedules) {
      if (!block.shift_start || !block.shift_end) continue
      let d = parseISO(block.shift_start)
      const end = parseISO(block.shift_end)
      while (d <= end) {
        const key = `${block.truck_number}__${format(d, 'yyyy-MM-dd')}`
        m.set(key, { ...m.get(key), sched: block })
        d = addDays(d, 1)
      }
    }

    for (const hold of holds) {
      if (!hold.start_date || !hold.end_date) continue
      let d = parseISO(hold.start_date)
      const end = parseISO(hold.end_date)
      while (d <= end) {
        const key      = `${hold.truck_number}__${format(d, 'yyyy-MM-dd')}`
        const existing = m.get(key) ?? {}
        // ATT_SOFT stored separately so regular holds always win
        if (hold.status === 'ATT_SOFT') {
          m.set(key, { ...existing, attHold: hold })
        } else {
          m.set(key, { ...existing, hold })
        }
        d = addDays(d, 1)
      }
    }

    return m
  }, [schedules, holds])

  // ── Filtered truck list ───────────────────────────────────────────────────

  let truckNums = trucks.map((t) => t.truck_number).sort()

  // MARKET FILTER: truck.last_known_market matches OR any schedule block market matches.
  if (filters.market) {
    const fm = filters.market.toLowerCase().trim()
    const matched = new Set<string>()

    for (const t of trucks) {
      if ((t.last_known_market ?? '').toLowerCase().trim() === fm) matched.add(t.truck_number)
    }
    for (const block of schedules) {
      const blockMarket = (block.standard_market_name || block.market).toLowerCase().trim()
      if (blockMarket === fm || block.market.toLowerCase().trim() === fm) matched.add(block.truck_number)
    }

    truckNums = truckNums.filter((t) => matched.has(t))
  }

  // STATE FILTER — priority: GPS state → schedule state → no match.
  // effectiveState = gpsState || scheduleState (first non-empty wins).
  // Applied after market filter → when both active, truck must satisfy both (AND).
  if (filters.state) {
    const fs = filters.state.toLowerCase().trim()
    truckNums = truckNums.filter((t) => {
      const meta = truckMeta.get(t)
      if (!meta) return false
      const effectiveState = (meta.last_gps_state || meta.last_schedule_state || '').toLowerCase().trim()
      return effectiveState === fs
    })
  }

  // STATUS FILTER: show trucks that have at least one cell with that status.
  if (filters.statusFilters.size > 0) {
    const matched = new Set<string>()

    if (filters.statusFilters.has('SCHEDULED_LED')) {
      for (const b of schedules) if (b.program?.toLowerCase() !== 'truck maintenance') matched.add(b.truck_number)
    }
    if (filters.statusFilters.has('MAINTENANCE')) {
      for (const b of schedules) if (b.program?.toLowerCase() === 'truck maintenance') matched.add(b.truck_number)
    }
    if (filters.statusFilters.has('HOLD_TENTATIVE')) {
      for (const h of holds) { if (h.status === 'HOLD') matched.add(h.truck_number) }
    }
    if (filters.statusFilters.has('COMMITTED_NOT_SET')) {
      for (const h of holds) { if (h.status === 'COMMITTED') matched.add(h.truck_number) }
    }
    if (filters.statusFilters.has('ATT_SOFT')) {
      for (const h of holds) { if (h.status === 'ATT_SOFT') matched.add(h.truck_number) }
    }
    if (filters.statusFilters.has('EMPTY')) {
      const scheduledSet = new Set(schedules.map((b) => b.truck_number))
      const holdSet      = new Set(holds.map((h) => h.truck_number))
      for (const t of truckNums) {
        if (!scheduledSet.has(t) && !holdSet.has(t)) matched.add(t)
      }
    }

    truckNums = truckNums.filter((t) => matched.has(t))
  }

  // ── Market grouping — use truckMeta (same source as side panel) with API GPS as fallback ──
  // truckMeta and trucks.last_known_market can diverge when multiple rows share the same
  // shift_start date (tie-breaking differs). truckMeta is always consistent with the panel.
  const truckMarketLookup = new Map(trucks.map((t) => {
    const metaMarket = truckMeta.get(t.truck_number)?.last_known_market
    return [t.truck_number, metaMarket || t.last_known_market || 'Unassigned']
  }))
  const groupMap = new Map<string, string[]>()
  for (const truckNum of truckNums) {
    const market = truckMarketLookup.get(truckNum) ?? 'Unassigned'
    if (!groupMap.has(market)) groupMap.set(market, [])
    groupMap.get(market)!.push(truckNum)
  }
  for (const gr of groupMap.values()) gr.sort()
  const marketGroups = [...groupMap.entries()].sort(([a], [b]) => {
    if (a === 'Unassigned') return 1
    if (b === 'Unassigned') return -1
    return a.localeCompare(b)
  })

  // ── Cell synthesis ────────────────────────────────────────────────────────
  // Priority: hold > schedule > empty (grey).

  const getCellData = (truckNum: string, date: Date): ScheduleRow => {
    const dateStr = format(date, 'yyyy-MM-dd')
    const entry   = dataMap.get(`${truckNum}__${dateStr}`)
    const meta    = truckMeta.get(truckNum)

    const base: ScheduleRow = {
      truck_number:       truckNum,
      calendar_date:      dateStr,
      display_status:     'EMPTY',
      market:             '',
      state:              '',
      program:            '',
      shift_start:        null,
      shift_end:          null,
      formatted_location: meta?.last_gps          ?? '',
      last_known_market:  meta?.last_known_market ?? '',
      last_gps_state:     meta?.last_gps_state    ?? '',
    }

    if (!entry) return base

    // 1. Regular hold (highest priority; flag if a schedule also overlaps — conflict)
    if (entry.hold) {
      return {
        ...base,
        display_status:  entry.hold.status === 'COMMITTED' ? 'COMMITTED_NOT_SET' : 'HOLD_TENTATIVE',
        hold_id:         entry.hold.id,
        client_name:     entry.hold.client_name,
        hold_market:     entry.hold.market,
        hold_state:      entry.hold.state,
        hold_notes:      entry.hold.notes,
        hold_created_by: entry.hold.user_name ?? entry.hold.created_by,
        conflictProgram: entry.sched?.program,
      }
    }

    // 2. Maintenance block — distinct orange; holds blocked
    if (entry.sched?.program?.toLowerCase() === 'truck maintenance') {
      return {
        ...base,
        display_status: 'MAINTENANCE',
        program:        entry.sched.program,
        shift_start:    entry.sched.shift_start,
        shift_end:      entry.sched.shift_end,
      }
    }

    // 3. Scheduled LED block (overrides ATT soft hold — turns blue → green automatically)
    if (entry.sched) {
      return {
        ...base,
        display_status:       'SCHEDULED_LED',
        market:               entry.sched.market,
        standard_market_name: entry.sched.standard_market_name,
        state:                entry.sched.state,
        program:              entry.sched.program,
        shift_start:          entry.sched.shift_start,
        shift_end:            entry.sched.shift_end,
      }
    }

    // 4. ATT soft hold (lowest priority — yields to any schedule or regular hold)
    if (entry.attHold) {
      return {
        ...base,
        display_status:  'ATT_SOFT',
        hold_id:         entry.attHold.id,
        client_name:     entry.attHold.client_name,
        hold_notes:      entry.attHold.notes,
        hold_created_by: entry.attHold.user_name ?? entry.attHold.created_by,
      }
    }

    // 4. Empty (grey)
    return base
  }

  // ── Drag interaction ──────────────────────────────────────────────────────

  const isInDragRange = (truckNum: string, dateIdx: number): boolean => {
    if (!dragStart || !dragEnd || dragStart.truck !== truckNum || dragEnd.truck !== truckNum) return false
    const min = Math.min(dragStart.dateIdx, dragEnd.dateIdx)
    const max = Math.max(dragStart.dateIdx, dragEnd.dateIdx)
    return dateIdx >= min && dateIdx <= max
  }

  const handleMouseDown = (truckNum: string, dateIdx: number, cell: ScheduleRow) => {
    isDragging.current  = true
    hasMoved.current    = false
    pendingCell.current = cell
    setDragStart({ truck: truckNum, dateIdx })
    setDragEnd({ truck: truckNum, dateIdx })
  }

  const handleMouseEnter = (truckNum: string, dateIdx: number) => {
    if (!isDragging.current || !dragStart || dragStart.truck !== truckNum) return
    if (pendingCell.current?.display_status === 'SCHEDULED_LED' ||
        pendingCell.current?.display_status === 'MAINTENANCE') return
    if (truckNum !== dragStart.truck || dateIdx !== dragStart.dateIdx) hasMoved.current = true
    setDragEnd({ truck: truckNum, dateIdx })
  }

  const handleMouseUp = useCallback(() => {
    if (!isDragging.current) return
    isDragging.current = false

    if (dragStart && dragEnd && dragStart.truck === dragEnd.truck) {
      const minIdx = Math.min(dragStart.dateIdx, dragEnd.dateIdx)
      const maxIdx = Math.max(dragStart.dateIdx, dragEnd.dateIdx)

      if (hasMoved.current && minIdx !== maxIdx) {
        // Block hold if any date in the range already has a schedule block
        const truckNum = dragStart.truck
        let schedConflict: { date: Date; program: string } | null = null
        for (let i = minIdx; i <= maxIdx; i++) {
          const entry = dataMap.get(`${truckNum}__${format(dates[i], 'yyyy-MM-dd')}`)
          if (entry?.sched) { schedConflict = { date: dates[i], program: entry.sched.program }; break }
        }

        if (schedConflict) {
          const isMaint = schedConflict.program?.toLowerCase() === 'truck maintenance'
          toast.error(
            isMaint
              ? `Truck ${truckNum} is under maintenance on ${format(schedConflict.date, 'MMM d')} — holds cannot be placed`
              : `Cannot place hold — Truck ${truckNum} is already scheduled for "${schedConflict.program}" on ${format(schedConflict.date, 'MMM d')}`
          )
        } else {
          setHoldRange({ truck: truckNum, start: dates[minIdx], end: dates[maxIdx] })
          setShowHoldModal(true)
        }
      } else {
        setSelectedCell(pendingCell.current)
      }
    }

    setDragStart(null)
    setDragEnd(null)
    hasMoved.current = false
  }, [dragStart, dragEnd, dates, dataMap])

  useEffect(() => {
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [handleMouseUp])

  // ── Hold submission ───────────────────────────────────────────────────────

  const handleHoldSubmit = async (formData: {
    client_name: string
    market: string
    state: string
    status: string
    notes: string
  }) => {
    if (!holdRange) return
    const res = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        truck_number: holdRange.truck,
        start_date:   format(holdRange.start, 'yyyy-MM-dd'),
        end_date:     format(holdRange.end,   'yyyy-MM-dd'),
        ...formData,
      }),
    })
    if (res.ok) {
      toast.success('Hold placed successfully')
      onHoldCreated()
      setShowHoldModal(false)
      setHoldRange(null)
    } else {
      const err = await res.json()
      toast.error(err.error || 'Failed to place hold')
    }
  }

  const handlePanelPlaceHold = () => {
    if (!selectedCell) return
    const date = new Date(selectedCell.calendar_date)
    setHoldRange({
      truck: selectedCell.truck_number,
      start: startOfDay(date),
      end:   startOfDay(date),
    })
    setShowHoldModal(true)
  }

  const todayIdx       = dates.findIndex((d) => isSameDay(d, today))
  const panelLastMarket = selectedCell
    ? (truckMeta.get(selectedCell.truck_number)?.last_known_market ?? '')
    : ''

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex gap-3 h-full min-h-0">

      {/* Scrollable schedule grid */}
      <div className="flex-1 overflow-auto select-none min-w-0">
        <table className="border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-30 w-[7.5rem] min-w-[7.5rem] bg-white border-b border-r border-gray-200 px-2 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide text-left">
                Market
              </th>
              <th className="sticky top-0 left-[7.5rem] z-30 w-24 min-w-[6rem] bg-white border-b border-r border-gray-200 px-2 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide text-left">
                Truck
              </th>
              {dates.map((date, idx) => (
                <th
                  key={idx}
                  className={`sticky top-0 z-20 w-10 min-w-[2.5rem] text-center py-1 border-b border-r border-gray-200 text-xs font-medium ${
                    isSameDay(date, today)
                      ? 'bg-green-700 text-white'
                      : date.getDay() === 0 || date.getDay() === 6
                      ? 'bg-gray-50 text-gray-400'
                      : 'text-gray-600 bg-white'
                  }`}
                >
                  <div>{format(date, 'M/d')}</div>
                  <div className="text-[10px] opacity-70">{format(date, 'EEE')}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {truckNums.length === 0 ? (
              <tr>
                <td colSpan={dates.length + 2} className="py-16 text-center text-gray-400">
                  No trucks match the current filters
                </td>
              </tr>
            ) : (
              marketGroups.flatMap(([market, groupTrucks], groupIdx) =>
                groupTrucks.map((truckNum, truckIdx) => {
                  const isFirstInGroup = truckIdx === 0
                  const groupTopBorder = groupIdx > 0 && isFirstInGroup ? 'border-t-2 border-t-gray-300' : ''

                  return (
                    <tr key={truckNum}>

                      {/* Market cell — spans all truck rows in this group */}
                      {isFirstInGroup && (
                        <td
                          rowSpan={groupTrucks.length}
                          className={`sticky left-0 z-10 w-[7.5rem] min-w-[7.5rem] bg-[#f0fdf4] border-b border-r border-gray-200 px-2 align-middle text-sm font-bold text-green-900 ${
                            groupIdx > 0 ? 'border-t-2 border-t-gray-300' : ''
                          }`}
                        >
                          {market}
                        </td>
                      )}

                      {/* Truck number */}
                      <td className={`sticky left-[7.5rem] z-10 w-24 min-w-[6rem] bg-gray-50 border-b border-r border-gray-200 px-2 py-1.5 text-sm font-semibold text-gray-700 ${groupTopBorder}`}>
                        {truckNum}
                      </td>

                      {/* Date cells */}
                      {dates.map((date, dateIdx) => {
                        const cell    = getCellData(truckNum, date)
                        const status  = cell.display_status
                        const inDrag  = isInDragRange(truckNum, dateIdx)
                        const isToday = dateIdx === todayIdx

                        // Red drag highlight when a cell in the drag range has a schedule block
                        const dragEntry = inDrag
                          ? dataMap.get(`${truckNum}__${format(date, 'yyyy-MM-dd')}`)
                          : undefined
                        const inDragConflict = inDrag && !!dragEntry?.sched

                        const statusLabel = STATUS_LABELS[status] ?? status
                        const mktLabel    = cell.hold_market || cell.market || cell.last_known_market || ''
                        const stateLabel  = cell.last_gps_state || ''
                        const clientLabel = cell.client_name
                        let tooltip = `${truckNum} · ${format(date, 'MMM d')} · ${statusLabel}`
                        if (cell.conflictProgram) tooltip = `⚠️ CONFLICT: Hold for "${clientLabel}" + Scheduled "${cell.conflictProgram}"`
                        else {
                          if (mktLabel)    tooltip += ` · ${mktLabel}`
                          if (stateLabel)  tooltip += ` · ${stateLabel}`
                          if (clientLabel) tooltip += ` · ${clientLabel}`
                        }

                        const isSelected =
                          selectedCell?.truck_number === truckNum &&
                          selectedCell.calendar_date === format(date, 'yyyy-MM-dd')

                        // Diagonal stripe background for conflict cells (hold + schedule overlap)
                        const conflictStyle = cell.conflictProgram ? {
                          background: status === 'COMMITTED_NOT_SET'
                            ? 'repeating-linear-gradient(135deg,#fca5a5 0px,#ef4444 4px,#22c55e 4px,#22c55e 8px)'
                            : 'repeating-linear-gradient(135deg,#fde68a 0px,#fbbf24 4px,#22c55e 4px,#22c55e 8px)',
                        } : undefined

                        return (
                          <td
                            key={dateIdx}
                            className={`w-10 min-w-[2.5rem] h-9 border-b border-r border-gray-100 cursor-pointer transition-all ${
                              isSelected
                                ? 'ring-2 ring-blue-500 ring-inset z-[15]'
                                : inDragConflict
                                ? 'ring-2 ring-red-500 ring-inset brightness-90'
                                : inDrag
                                ? 'ring-2 ring-blue-400 ring-inset brightness-90'
                                : cell.conflictProgram
                                ? ''
                                : STATUS_COLORS[status]
                            } ${isToday ? 'border-l-2 border-l-green-700' : ''} ${groupTopBorder}`}
                            style={conflictStyle}
                            onMouseDown={() => handleMouseDown(truckNum, dateIdx, cell)}
                            onMouseEnter={() => handleMouseEnter(truckNum, dateIdx)}
                            title={tooltip}
                          />
                        )
                      })}
                    </tr>
                  )
                })
              )
            )}
          </tbody>
        </table>
      </div>

      {/* Side panel */}
      <CellDetail
        cell={selectedCell}
        lastKnownMarket={panelLastMarket}
        onClose={() => setSelectedCell(null)}
        onPlaceHold={handlePanelPlaceHold}
        onHoldDeleted={() => {
          onHoldCreated()
          setSelectedCell(null)
        }}
      />

      {/* Hold modal */}
      {showHoldModal && holdRange && (
        <HoldModal
          truck={holdRange.truck}
          startDate={holdRange.start}
          endDate={holdRange.end}
          markets={markets}
          onSubmit={handleHoldSubmit}
          onClose={() => {
            setShowHoldModal(false)
            setHoldRange(null)
          }}
        />
      )}

      {/* Legend */}
      <div className="hidden xl:flex flex-col gap-2 pt-2 text-xs min-w-[100px] flex-shrink-0">
        <div className="font-semibold text-gray-500 uppercase tracking-wide mb-1">Legend</div>
        {(['EMPTY', 'SCHEDULED_LED', 'MAINTENANCE', 'HOLD_TENTATIVE', 'COMMITTED_NOT_SET', 'ATT_SOFT'] as const).map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`w-4 h-4 rounded-sm ${STATUS_COLORS[s].split(' ')[0]} border ${STATUS_BORDER[s]}`} />
            <span className="text-gray-600">{STATUS_LABELS[s]}</span>
          </div>
        ))}
        <div className="mt-3 text-gray-400 leading-tight">
          <div className="font-medium text-gray-500 mb-1">How to use</div>
          <div>Click cell → details</div>
          <div>Drag cells → hold</div>
        </div>
      </div>
    </div>
  )
}

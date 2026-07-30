'use client'

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { format, addDays, startOfDay, parseISO, isSameDay } from 'date-fns'
import toast from 'react-hot-toast'
import { HoldModal } from './HoldModal'
import { CellDetail } from './CellDetail'
import { getNearbyMarkets, getMarketCoords, haversineDistance } from '@/lib/marketCoordinates'

// ── Exported data types (match API response) ──────────────────────────────────

export type TruckInfo = {
  truck_number:      string
  last_gps:          string        // full address string, e.g. "Street, City, ST, ZIP"
  last_gps_city:     string | null
  last_gps_state:    string | null
  last_gps_lat:      number | null
  last_gps_lng:      number | null
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
  origination: string
}

export type HoldRequestBlock = {
  id:           string
  truck_number: string
  market:       string
  state:        string
  notes:        string
  start_date:   string       // YYYY-MM-DD
  end_date:     string       // YYYY-MM-DD
  status:       'PENDING' | 'APPROVED' | 'REJECTED'
  company_name: string
}

// ── Internal synthesised row type (used by CellDetail / HoldModal) ────────────

export type ScheduleRow = {
  truck_number: string
  market: string
  state: string
  program: string
  formatted_location: string
  display_status: 'EMPTY' | 'SCHEDULED_LED' | 'HOLD_TENTATIVE' | 'COMMITTED_NOT_SET' | 'ATT_SOFT' | 'MAINTENANCE' | 'DEPARTING' | 'HOLD_REQUEST'
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
  hold_origination?: string
  /** Set when a hold and a schedule block occupy the same cell — conflict indicator */
  conflictProgram?: string
  departing_to?: string
  departing_on?: string
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
  DEPARTING:          'bg-gray-200 hover:bg-gray-300',
  HOLD_REQUEST:       'bg-yellow-400 hover:bg-yellow-500',
}


// Client view: available = green, anything booked/unavailable = gray
const CLIENT_STATUS_COLORS: Record<string, string> = {
  EMPTY:              'bg-green-500 hover:bg-green-600',
  SCHEDULED_LED:      'bg-gray-300 hover:bg-gray-400',
  HOLD_TENTATIVE:     'bg-gray-300 hover:bg-gray-400',
  COMMITTED_NOT_SET:  'bg-gray-300 hover:bg-gray-400',
  ATT_SOFT:           'bg-gray-300 hover:bg-gray-400',
  MAINTENANCE:        'bg-gray-300 hover:bg-gray-400',
  DEPARTING:          'bg-green-500 hover:bg-green-600',
  HOLD_REQUEST:       'bg-yellow-400 hover:bg-yellow-500',
}


const STATUS_LABELS: Record<string, string> = {
  EMPTY:              'Available',
  SCHEDULED_LED:      'Scheduled',
  HOLD_TENTATIVE:     'On Hold',
  COMMITTED_NOT_SET:  'Committed',
  ATT_SOFT:           'ATT Hold',
  MAINTENANCE:        'Maintenance',
  DEPARTING:          'Departing',
  HOLD_REQUEST:       'Requested',
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
  holdRequests?: HoldRequestBlock[]
  filters: Filters
  onHoldCreated: () => void
  onCellRangeSelected?: (truckNum: string, start: string, end: string, market: string) => void
  markets: string[]
  states: string[]
  clientView?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function ScheduleGrid({ trucks, schedules, holds, holdRequests = [], filters, onHoldCreated, onCellRangeSelected, markets, states: _states, clientView = false }: ScheduleGridProps) {
  const today = startOfDay(new Date())
  const dateFrom = filters.dateFrom ? startOfDay(parseISO(filters.dateFrom)) : addDays(today, -7)
  const dateTo   = filters.dateTo   ? startOfDay(parseISO(filters.dateTo))   : addDays(today, 90)
  const dates = getDates(dateFrom, dateTo)

  const [selectedCell, setSelectedCell] = useState<ScheduleRow | null>(null)
  const [dragStart, setDragStart] = useState<{ truck: string; dateIdx: number } | null>(null)
  const [dragEnd,   setDragEnd]   = useState<{ truck: string; dateIdx: number } | null>(null)
  const [showHoldModal, setShowHoldModal] = useState(false)
  const [holdRange, setHoldRange] = useState<{ truck: string; start: Date; end: Date } | null>(null)

  const isDragging    = useRef(false)
  const hasMoved      = useRef(false)
  const pendingCell   = useRef<ScheduleRow | null>(null)
  const dragStartRef  = useRef<{ truck: string; dateIdx: number } | null>(null)

  // ── Per-truck derived data ────────────────────────────────────────────────
  // Computed once when trucks/schedules change. Avoids per-cell recalculation.
  //
  // last_gps_state      = address.split(',')[2].trim()  (index 2 of "Street, City, ST, ZIP")
  // last_schedule_state = state field of the most recent schedule block (any date)
  // last_known_market   = std market of truck's CURRENT position (for row grouping):
  //   - active today → today's shift's std market
  //   - not active today → most recent past shift's std market
  //   - no shifts → '' (falls back to GPS in truckMarketLookup)
  // shiftsByEnd = shifts sorted by shift_end desc, used for per-cell "last market" lookup

  const truckMeta = useMemo(() => {
    const todayStr = format(startOfDay(new Date()), 'yyyy-MM-dd')

    const meta = new Map<string, {
      last_gps:             string
      last_gps_state:       string
      last_gps_lat:         number | null
      last_gps_lng:         number | null
      last_schedule_state:  string
      last_known_market:    string
      last_gps_city:        string
      last_known_state:     string  // state from current/last std market; GPS only if no shifts
      shiftsByEnd:          Array<{ shift_end: string; market: string }>
      shiftsByStart:        Array<{ shift_start: string; market: string }>
      _bestSchedStart:      string
      _todayShiftStart:     string
      _todayShiftState:     string
      _lastPastEnd:         string
      _lastPastMarket:      string
      _lastPastState:       string
    }>()

    for (const t of trucks) {
      meta.set(t.truck_number, {
        last_gps:            t.last_gps,
        last_gps_city:       t.last_gps_city || '',
        last_gps_state:      extractState(t.last_gps),
        last_gps_lat:        t.last_gps_lat ?? null,
        last_gps_lng:        t.last_gps_lng ?? null,
        last_schedule_state: '',
        last_known_market:   '',
        last_known_state:    '',
        shiftsByEnd:         [],
        shiftsByStart:       [],
        _bestSchedStart:     '',
        _todayShiftStart:    '',
        _todayShiftState:    '',
        _lastPastEnd:        '',
        _lastPastMarket:     '',
        _lastPastState:      '',
      })
    }

    for (const block of schedules) {
      if (!block.shift_start || !block.shift_end) continue
      const entry = meta.get(block.truck_number)
      if (!entry) continue

      if (block.shift_start >= entry._bestSchedStart) {
        entry._bestSchedStart     = block.shift_start
        entry.last_schedule_state = block.state
      }

      const blockMarket = block.standard_market_name || block.market

      entry.shiftsByEnd.push({ shift_end: block.shift_end, market: blockMarket })
      entry.shiftsByStart.push({ shift_start: block.shift_start, market: blockMarket })

      // Active today: take the latest-starting shift (most specific)
      if (block.shift_start <= todayStr && block.shift_end >= todayStr) {
        if (block.shift_start >= entry._todayShiftStart) {
          entry._todayShiftStart  = block.shift_start
          entry.last_known_market = blockMarket
          entry._todayShiftState  = block.state
        }
      }

      // Most recent completed shift — fallback if not active today
      if (block.shift_end < todayStr) {
        if (block.shift_end > entry._lastPastEnd) {
          entry._lastPastEnd    = block.shift_end
          entry._lastPastMarket = blockMarket
          entry._lastPastState  = block.state
        }
      }
    }

    // Include holds so DEPARTING logic doesn't false-positive across hold→schedule same-market gaps
    for (const hold of holds) {
      if (!hold.start_date || !hold.end_date || !hold.market) continue
      const entry = meta.get(hold.truck_number)
      if (!entry) continue
      entry.shiftsByEnd.push({ shift_end: hold.end_date, market: hold.market })
      entry.shiftsByStart.push({ shift_start: hold.start_date, market: hold.market })
    }

    // Sort shiftsByEnd descending so getCellData can find the last shift before a date quickly
    for (const entry of meta.values()) {
      entry.shiftsByEnd.sort((a, b) => b.shift_end.localeCompare(a.shift_end))
      entry.shiftsByStart.sort((a, b) => a.shift_start.localeCompare(b.shift_start))
      if (!entry._todayShiftStart && entry._lastPastMarket) {
        entry.last_known_market = entry._lastPastMarket
      }
      // State: current shift → last past shift → GPS fallback
      entry.last_known_state = entry._todayShiftState || entry._lastPastState || entry.last_gps_state
    }

    return meta
  }, [trucks, schedules, holds])

  // ── Day-level lookup map ──────────────────────────────────────────────────
  // "truck__YYYY-MM-DD" → { sched?, hold? }
  // Holds are layered on top of schedules; holds take priority in getCellData.

  const dataMap = useMemo(() => {
    const m = new Map<string, { sched?: ScheduleBlock; hold?: HoldBlock; attHold?: HoldBlock; holdReq?: HoldRequestBlock }>()

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

    for (const req of holdRequests) {
      if (!req.start_date || !req.end_date) continue
      let d = parseISO(req.start_date)
      const end = parseISO(req.end_date)
      while (d <= end) {
        const key = `${req.truck_number}__${format(d, 'yyyy-MM-dd')}`
        const existing = m.get(key) ?? {}
        if (!existing.hold && !existing.sched) m.set(key, { ...existing, holdReq: req })
        d = addDays(d, 1)
      }
    }

    return m
  }, [schedules, holds, holdRequests])

  // Pre-compute non-ATT schedules per truck for ATT_SOFT voiding logic
  const nonAttSchedulesByTruck = useMemo(() => {
    const m = new Map<string, Array<{ shift_start: string; shift_end: string }>>()
    for (const block of schedules) {
      if (block.program?.toLowerCase().includes('att')) continue
      if (!m.has(block.truck_number)) m.set(block.truck_number, [])
      m.get(block.truck_number)!.push({ shift_start: block.shift_start, shift_end: block.shift_end })
    }
    return m
  }, [schedules])

  // ── Filtered truck list ───────────────────────────────────────────────────

  let truckNums = trucks.map((t) => t.truck_number).sort()

  const dfStr = filters.dateFrom || ''
  const dtStr = filters.dateTo   || ''

  // MARKET FILTER:
  //   Uses the same market priority as the display grouping (today's shift → next future shift → GPS).
  //   Proximity (250 miles): city-name table lookup first; if city unknown, fall back to actual GPS
  //   coordinates so small/suburb cities (e.g. Rockwall, TX) work without being hardcoded.
  //   Schedule blocks with the exact selected market also match (trucks heading there).
  if (filters.market) {
    const _todayStr      = format(today, 'yyyy-MM-dd')
    const nearbyMarkets  = getNearbyMarkets(filters.market, markets, 250)
    const nearbyLower    = new Set(Array.from(nearbyMarkets).map((m) => m.toLowerCase().trim()))
    const exactLower     = filters.market.toLowerCase().trim()
    const selectedCoords = getMarketCoords(filters.market)
    const matched = new Set<string>()

    for (const t of trucks) {
      const meta       = truckMeta.get(t.truck_number)
      const todayMkt   = meta?._todayShiftStart ? meta.last_known_market : null
      const futureMkt  = meta?.shiftsByStart.find(s => s.shift_start > _todayStr)?.market ?? null
      const gpsMkt     = t.last_gps_city ? [t.last_gps_city, t.last_gps_state].filter(Boolean).join(', ') : null
      const displayMkt = (todayMkt || futureMkt || gpsMkt || '').toLowerCase().trim()

      if (nearbyLower.has(displayMkt)) {
        matched.add(t.truck_number)
      } else if (selectedCoords && !todayMkt && !futureMkt && meta?.last_gps_lat && meta?.last_gps_lng) {
        // GPS-only truck whose city isn't in the name table — compare raw coordinates
        const dist = haversineDistance(meta.last_gps_lat, meta.last_gps_lng, selectedCoords.lat, selectedCoords.lng)
        if (dist <= 250) matched.add(t.truck_number)
      }
    }
    for (const block of schedules) {
      if (!block.shift_start || !block.shift_end) continue
      if (dfStr && block.shift_end   < dfStr) continue
      if (dtStr && block.shift_start > dtStr) continue
      const blockMarket = (block.standard_market_name || block.market).toLowerCase().trim()
      if (blockMarket === exactLower || block.market.toLowerCase().trim() === exactLower) {
        matched.add(block.truck_number)
      }
    }

    truckNums = truckNums.filter((t) => matched.has(t))
  }

  // STATE FILTER — priority: current/last std market state → GPS (only if no shifts).
  if (filters.state) {
    const fs = filters.state.toLowerCase().trim()
    truckNums = truckNums.filter((t) => {
      const meta = truckMeta.get(t)
      if (!meta) return false
      return meta.last_known_state.toLowerCase().trim() === fs
    })
  }

  // STATUS FILTER: show trucks that have at least one cell with that status
  // within the visible date range only.
  if (filters.statusFilters.size > 0) {
    const matched = new Set<string>()

    if (filters.statusFilters.has('SCHEDULED_LED')) {
      for (const b of schedules) {
        if (b.program?.toLowerCase() === 'truck maintenance') continue
        if (dfStr && b.shift_end   < dfStr) continue
        if (dtStr && b.shift_start > dtStr) continue
        matched.add(b.truck_number)
      }
    }
    if (filters.statusFilters.has('MAINTENANCE')) {
      for (const b of schedules) {
        if (b.program?.toLowerCase() !== 'truck maintenance') continue
        if (dfStr && b.shift_end   < dfStr) continue
        if (dtStr && b.shift_start > dtStr) continue
        matched.add(b.truck_number)
      }
    }
    if (filters.statusFilters.has('HOLD_TENTATIVE')) {
      for (const h of holds) {
        if (h.status !== 'HOLD') continue
        if (dfStr && h.end_date   < dfStr) continue
        if (dtStr && h.start_date > dtStr) continue
        matched.add(h.truck_number)
      }
    }
    if (filters.statusFilters.has('COMMITTED_NOT_SET')) {
      for (const h of holds) {
        if (h.status !== 'COMMITTED') continue
        if (dfStr && h.end_date   < dfStr) continue
        if (dtStr && h.start_date > dtStr) continue
        matched.add(h.truck_number)
      }
    }
    if (filters.statusFilters.has('ATT_SOFT')) {
      for (const h of holds) {
        if (h.status !== 'ATT_SOFT') continue
        if (dfStr && h.end_date   < dfStr) continue
        if (dtStr && h.start_date > dtStr) continue
        matched.add(h.truck_number)
      }
    }
    if (filters.statusFilters.has('EMPTY')) {
      for (const t of truckNums) {
        const hasAvailableDay = dates.some((date) => {
          const entry = dataMap.get(`${t}__${format(date, 'yyyy-MM-dd')}`)
          return !entry || (!entry.sched && !entry.hold && !entry.attHold)
        })
        if (hasAvailableDay) matched.add(t)
      }
    }

    truckNums = truckNums.filter((t) => matched.has(t))
  }

  // ── Market grouping ───────────────────────────────────────────────────────
  const todayStr = format(today, 'yyyy-MM-dd')
  const truckMarketLookup = new Map(trucks.map((t) => {
    const meta         = truckMeta.get(t.truck_number)
    const todayMarket  = meta?._todayShiftStart ? meta.last_known_market : null
    const nextShift    = meta?.shiftsByStart.find(s => s.shift_start > todayStr)
    const nextMkt      = nextShift?.market ?? null
    const gpsMarket    = t.last_gps_city ? [t.last_gps_city, t.last_gps_state].filter(Boolean).join(', ') : null
    // TODO: re-enable 7-day GPS threshold when ready:
    // const daysUntil = nextShift ? differenceInCalendarDays(parseISO(nextShift.shift_start), today) : Infinity
    // const nearMkt   = nextShift && daysUntil <= 7 ? nextShift.market : null  // ≤7 days → use shift market
    // const farMkt    = nextShift && daysUntil > 7  ? nextShift.market : null  // >7 days → GPS takes priority; this is last fallback
    // return [t.truck_number, todayMarket || nearMkt || gpsMarket || farMkt || 'Unassigned']
    return [t.truck_number, todayMarket || nextMkt || gpsMarket || meta?.last_known_market || 'Unassigned']
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
      last_known_market:  meta?.shiftsByStart.find(s => s.shift_start > dateStr)?.market
                          || (meta?.last_gps_city ? [meta.last_gps_city, meta.last_gps_state].filter(Boolean).join(', ') : '')
                          || '',
      last_gps_state:     meta?.last_gps_state    ?? '',
    }

    const withDeparting = (row: ScheduleRow): ScheduleRow => {
      if (row.display_status !== 'EMPTY') return row
      const nextShift = meta?.shiftsByStart.find(s => s.shift_start > dateStr)
      if (!nextShift?.market) return row
      // Find the most recent past shift within 30 days — prevents false positives from old history.
      // Any empty cell in a cross-market transition window inherits DEPARTING, not just the first.
      const thirtyDaysAgo = format(addDays(date, -30), 'yyyy-MM-dd')
      const prevShift = meta?.shiftsByEnd.find(s => s.shift_end < dateStr && s.shift_end >= thirtyDaysAgo)
      if (!prevShift?.market || prevShift.market === nextShift.market) return row
      return { ...row, display_status: 'DEPARTING', departing_to: nextShift.market, departing_on: nextShift.shift_start }
    }

    if (!entry) return withDeparting(base)

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
        hold_origination: entry.hold.origination,
        conflictProgram: entry.sched?.program,
      }
    }

    // 2. Maintenance block — distinct orange; holds blocked
    if (entry.sched?.program?.toLowerCase() === 'truck maintenance') {
      return {
        ...base,
        display_status:       'MAINTENANCE',
        market:               entry.sched.market,
        standard_market_name: entry.sched.standard_market_name,
        program:              entry.sched.program,
        shift_start:          entry.sched.shift_start,
        shift_end:            entry.sched.shift_end,
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
    //    If the truck has any non-ATT scheduled block overlapping this hold's period,
    //    treat the hold as void and show white/available instead of soft blue.
    if (entry.attHold) {
      const holdStart = entry.attHold.start_date
      const holdEnd   = entry.attHold.end_date
      const voided = nonAttSchedulesByTruck.get(truckNum)?.some(
        (s) => s.shift_start <= holdEnd && s.shift_end >= holdStart
      )
      if (voided) {
        if (entry.holdReq) return { ...base, display_status: 'HOLD_REQUEST', hold_id: entry.holdReq.id, client_name: entry.holdReq.company_name, hold_notes: entry.holdReq.notes }
        return withDeparting(base)
      }
      return {
        ...base,
        display_status:  'ATT_SOFT',
        hold_id:         entry.attHold.id,
        client_name:     entry.attHold.client_name,
        hold_notes:      entry.attHold.notes,
        hold_created_by: entry.attHold.user_name ?? entry.attHold.created_by,
      }
    }

    // 5. Client hold request (purple)
    if (entry.holdReq) {
      return {
        ...base,
        display_status: 'HOLD_REQUEST',
        hold_id:        entry.holdReq.id,
        client_name:    entry.holdReq.company_name,
        hold_notes:     entry.holdReq.notes,
      }
    }

    // 6. Empty (grey)
    return withDeparting(base)
  }

  // Near-term stripe dates: before 12pm CT → today + 1 next business day
  //                         after  12pm CT → today + 2 next business days
  // Walk forward day by day, blocking every date along the way (weekends included
  // when they fall inside the span) until the target number of business days is hit.
  const nearTermDates = useMemo(() => {
    const ctNow  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }))
    const count  = ctNow.getHours() < 12 ? 1 : 2
    const set    = new Set<string>()
    set.add(format(today, 'yyyy-MM-dd'))
    let d = addDays(today, 1)
    let added = 0
    while (added < count) {
      const dow = d.getDay()
      set.add(format(d, 'yyyy-MM-dd'))
      if (dow !== 0 && dow !== 6) added++
      d = addDays(d, 1)
    }
    return set
  }, [today])

  // ── Drag interaction ──────────────────────────────────────────────────────

  const isInDragRange = (truckNum: string, dateIdx: number): boolean => {
    if (!dragStart || !dragEnd || dragStart.truck !== truckNum || dragEnd.truck !== truckNum) return false
    const min = Math.min(dragStart.dateIdx, dragEnd.dateIdx)
    const max = Math.max(dragStart.dateIdx, dragEnd.dateIdx)
    return dateIdx >= min && dateIdx <= max
  }

  const handleMouseDown = (truckNum: string, dateIdx: number, cell: ScheduleRow) => {
    // Client hold requests: only allow drag on empty/departing cells
    if (onCellRangeSelected && clientView && cell.display_status !== 'EMPTY' && cell.display_status !== 'DEPARTING') return
    // Client hold requests: block near-term dates
    if (onCellRangeSelected && clientView && nearTermDates.has(format(dates[dateIdx], 'yyyy-MM-dd'))) return
    isDragging.current    = true
    hasMoved.current      = false
    pendingCell.current   = cell
    dragStartRef.current  = { truck: truckNum, dateIdx }
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

    // Single-cell click in client view — state may not have updated yet, so read from ref
    // (handleMouseDown already gated on EMPTY/DEPARTING, so no need to re-check here)
    if (onCellRangeSelected && clientView && !hasMoved.current && dragStartRef.current) {
      const { truck: truckNum, dateIdx } = dragStartRef.current
      const market = truckMarketLookup.get(truckNum) ?? ''
      dragStartRef.current = null
      setDragStart(null); setDragEnd(null); hasMoved.current = false
      onCellRangeSelected(truckNum, format(dates[dateIdx], 'yyyy-MM-dd'), format(dates[dateIdx], 'yyyy-MM-dd'), market)
      return
    }
    dragStartRef.current = null

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

        if (onCellRangeSelected && clientView) {
          // Block if any date in the range is near-term
          const hasNearTerm = Array.from({ length: maxIdx - minIdx + 1 }, (_, i) => format(dates[minIdx + i], 'yyyy-MM-dd')).some(d => nearTermDates.has(d))
          if (hasNearTerm) { setDragStart(null); setDragEnd(null); hasMoved.current = false; return }
          const market = truckMarketLookup.get(truckNum) ?? ''
          onCellRangeSelected(truckNum, format(dates[minIdx], 'yyyy-MM-dd'), format(dates[maxIdx], 'yyyy-MM-dd'), market)
        } else if (schedConflict) {
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
  }, [dragStart, dragEnd, dates, dataMap, onCellRangeSelected, clientView, truckMarketLookup, nearTermDates])

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

  const todayIdx = dates.findIndex((d) => isSameDay(d, today))

  const panelLastMarket = selectedCell?.display_status === 'EMPTY'
    ? (selectedCell.last_known_market ?? '')
    : ''

  const displayLabels = clientView
    ? { ...STATUS_LABELS, SCHEDULED_LED: 'Booked', HOLD_TENTATIVE: 'Booked', COMMITTED_NOT_SET: 'Booked', ATT_SOFT: 'Booked', MAINTENANCE: 'Booked' }
    : STATUS_LABELS

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex gap-3">

      {/* Scrollable schedule grid */}
      <div className="select-none">
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
                  className={`sticky top-0 z-20 w-20 min-w-[5rem] text-center py-1 border-b border-r border-gray-200 text-xs font-medium ${
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

                        const statusLabel = displayLabels[status] ?? status
                        const mktLabel    = cell.hold_market || cell.standard_market_name || cell.market || cell.last_known_market || ''
                        const stateLabel  = cell.last_gps_state || ''
                        const clientLabel = cell.client_name
                        let tooltip = `${truckNum} · ${statusLabel}`
                        if (!clientView) {
                          if (cell.conflictProgram) tooltip = `⚠️ CONFLICT: Hold for "${clientLabel}" + Scheduled "${cell.conflictProgram}"`
                          else {
                            if (mktLabel)    tooltip += ` · ${mktLabel}`
                            if (stateLabel)  tooltip += ` · ${stateLabel}`
                            if (clientLabel) tooltip += ` · ${clientLabel}`
                          }
                        } else {
                          // Client view: GPS state ⟶ market (where truck is → where it works/heads)
                          const clientMkt = cell.standard_market_name || cell.market || cell.hold_market || cell.last_known_market || ''
                          if (stateLabel && clientMkt) {
                            tooltip += ` · ${stateLabel} ⟶ ${clientMkt}`
                          } else if (stateLabel) {
                            tooltip += ` · ${stateLabel}`
                          } else if (clientMkt) {
                            tooltip += ` · ${clientMkt}`
                          }
                        }
                        if (status === 'DEPARTING' && cell.departing_to && cell.departing_on) {
                          tooltip = `${truckNum} · Shift in ${cell.departing_to} on ${format(parseISO(cell.departing_on + 'T12:00:00'), 'MMM d')}`
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

                        const isDeparting  = status === 'DEPARTING' && !!cell.departing_to
                        const deptStateParts = isDeparting ? (cell.departing_to ?? '').split(',') : null
                        const deptCity      = deptStateParts?.[0]?.trim() ?? ''
                        const deptState     = deptStateParts?.[1]?.trim() ?? ''
                        // Suppress text when the departure destination is the same as the truck's current group
                        const truckGroupMkt = truckMarketLookup.get(truckNum) ?? ''
                        const showDeptText  = isDeparting && (cell.departing_to ?? '').toLowerCase().trim() !== truckGroupMkt.toLowerCase().trim()
                        const isNearTerm    = nearTermDates.has(format(date, 'yyyy-MM-dd'))

                        return (
                          <td
                            key={dateIdx}
                            className={`w-20 min-w-[5rem] h-12 border-b border-r border-gray-100 ${clientView && !onCellRangeSelected ? 'cursor-default' : 'cursor-pointer'} transition-all ${
                              isSelected
                                ? 'ring-2 ring-blue-500 ring-inset z-[15]'
                                : inDragConflict
                                ? 'ring-2 ring-red-500 ring-inset brightness-90'
                                : inDrag
                                ? 'ring-2 ring-blue-400 ring-inset brightness-90'
                                : cell.conflictProgram
                                ? ''
                                : (clientView ? CLIENT_STATUS_COLORS : STATUS_COLORS)[status]
                            } ${isToday ? 'border-l-2 border-l-green-700' : ''} ${groupTopBorder}${showDeptText ? ' relative overflow-visible group/dp' : isNearTerm ? ' relative' : ''}`}
                            style={conflictStyle}
                            onMouseDown={clientView && !onCellRangeSelected ? undefined : () => handleMouseDown(truckNum, dateIdx, cell)}
                            onMouseEnter={clientView && !onCellRangeSelected ? undefined : () => handleMouseEnter(truckNum, dateIdx)}
                            title={showDeptText ? undefined : tooltip}
                          >
                            {isNearTerm && (
                              <div className="absolute inset-0 pointer-events-none" style={{
                                background: 'repeating-linear-gradient(135deg, rgba(239,68,68,0.35) 0px, rgba(239,68,68,0.35) 2px, transparent 2px, transparent 9px)',
                              }} />
                            )}
                            {showDeptText && (
                              <>
                                <div className="flex flex-col items-center justify-center h-full gap-px group-hover/dp:opacity-0 transition-opacity duration-100 pointer-events-none px-0.5">
                                  <span className="text-[10px] font-semibold text-gray-700 leading-tight w-full text-center truncate">{deptCity}</span>
                                  <span className="text-[10px] font-bold text-amber-700 leading-tight">{deptState}</span>
                                </div>
                                <div className="hidden group-hover/dp:flex absolute left-1/2 -translate-x-1/2 top-full mt-0.5 z-50 bg-white border border-amber-200 rounded-lg shadow-xl px-2.5 py-1.5 flex-col gap-0.5 whitespace-nowrap pointer-events-none">
                                  <span className="text-[10px] text-gray-400 uppercase tracking-wide">Moving to</span>
                                  <span className="text-xs font-semibold text-gray-800">→ {cell.departing_to}</span>
                                  {cell.departing_on && (
                                    <span className="text-[10px] text-gray-500">Shift on {format(parseISO(cell.departing_on + 'T12:00:00'), 'MMM d')}</span>
                                  )}
                                </div>
                              </>
                            )}
                          </td>
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

      {/* Side panel — internal users only */}
      {!clientView && (
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
      )}

      {/* Hold modal — internal users only */}
      {!clientView && showHoldModal && holdRange && (
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

    </div>
  )
}

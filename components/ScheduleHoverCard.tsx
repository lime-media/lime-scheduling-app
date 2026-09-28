'use client'

/**
 * Schedule grid hover card — internal view only. Shows what is happening on a
 * truck-day: the scheduled program or the reservation, its client, market and
 * dates, notes, who created it, and any conflict between a hold and a shift.
 *
 * It keeps its own state and is driven through a ref (show / move / hide), so
 * moving the pointer re-renders only this card, never the grid.
 */

import { useEffect, useState, type MutableRefObject } from 'react'
import { format, parseISO } from 'date-fns'
import { STATUS_BADGE, UNKNOWN_BADGE, type DisplayStatus } from '@/lib/statusColors'
import type { ScheduleRow } from '@/components/ScheduleGrid'

export type ScheduleHoverApi = {
  show: (cell: ScheduleRow, label: string, x: number, y: number) => void
  move: (x: number, y: number) => void
  hide: () => void
}

const day = (d?: string | null) => (d ? format(parseISO(d + 'T12:00:00'), 'MMM d') : '')
const range = (a?: string | null, b?: string | null) => (a && b ? (a === b ? day(a) : `${day(a)} – ${day(b)}`) : '')

export function ScheduleHoverCard({ apiRef }: { apiRef: MutableRefObject<ScheduleHoverApi | null> }) {
  const [state, setState] = useState<{ cell: ScheduleRow; label: string; x: number; y: number } | null>(null)

  useEffect(() => {
    apiRef.current = {
      show: (cell, label, x, y) => setState({ cell, label, x, y }),
      move: (x, y) => setState(s => (s && (s.x !== x || s.y !== y) ? { ...s, x, y } : s)),
      hide: () => setState(null),
    }
    return () => { apiRef.current = null }
  }, [apiRef])

  if (!state) return null
  const { cell, label, x, y } = state
  const status = cell.display_status as DisplayStatus
  const isReservation = status === 'HOLD_TENTATIVE' || status === 'COMMITTED_NOT_SET' || status === 'HOLD_REQUEST' || status === 'ATT_SOFT'
  const market = cell.hold_market || cell.standard_market_name || cell.market || ''
  const rows: [string, string][] = []
  if (status === 'SCHEDULED_LED' || status === 'MAINTENANCE') {
    if (cell.program) rows.push(['Program', cell.program])
    if (market) rows.push(['Market', market])
    const r = range(cell.shift_start, cell.shift_end)
    if (r) rows.push(['Shift', r])
  } else if (isReservation) {
    if (cell.client_name) rows.push(['Client', cell.client_name])
    if (market) rows.push(['Market', [market, cell.hold_state && !market.includes(',') ? cell.hold_state : ''].filter(Boolean).join(', ')])
    const r = range(cell.hold_start, cell.hold_end)
    if (r) rows.push(['Dates', r])
    if (cell.hold_created_by) rows.push(['By', cell.hold_created_by])
    if (cell.hold_origination === 'mcp') rows.push(['Via', 'MCP'])
    if (cell.hold_notes) rows.push(['Notes', cell.hold_notes])
  } else if (status === 'DEPARTING' && cell.departing_to) {
    rows.push(['Next', `${cell.departing_to}${cell.departing_on ? ` on ${day(cell.departing_on)}` : ''}`])
  } else {
    const where = cell.last_known_market || cell.formatted_location
    if (where) rows.push(['Last seen', where])
  }

  const W = 280, H = 70 + rows.length * 20 + (cell.conflictProgram ? 36 : 0)
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const left = x + 14 + W > vw ? Math.max(8, x - 14 - W) : x + 14
  const top = y + 14 + H > vh ? Math.max(8, y - 14 - H) : y + 14

  return (
    <div className="fixed z-50 pointer-events-none bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-xs" style={{ left, top, width: W }} role="tooltip">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-gray-900">#{cell.truck_number}</span>
        <span className="text-gray-500">{cell.calendar_date ? format(parseISO(cell.calendar_date + 'T12:00:00'), 'EEE, MMM d') : ''}</span>
        <span className={`ml-auto inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS_BADGE[status] ?? UNKNOWN_BADGE}`}>{label}</span>
      </div>
      {cell.conflictProgram && (
        <div className="mt-1.5 rounded bg-red-50 border border-red-200 px-2 py-1 text-red-800">
          Conflict: this reservation overlaps the scheduled program “{cell.conflictProgram}”.
        </div>
      )}
      {rows.length > 0 && (
        <dl className="mt-1.5 grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-0.5">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-gray-500">{k}</dt>
              <dd className={`text-gray-800 ${k === 'Notes' ? 'line-clamp-3' : 'truncate'}`}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

'use client'

import { format, parseISO } from 'date-fns'
import { STATUS_BADGE, RESERVATION_LABEL, COMMITTED_LABEL } from '@/lib/statusColors'
import toast from 'react-hot-toast'
import type { ScheduleRow } from './ScheduleGrid'

interface CellDetailProps {
  cell: ScheduleRow | null
  lastKnownMarket: string
  onClose: () => void
  onHoldDeleted: () => void
}

const STATUS_LABELS: Record<string, string> = {
  EMPTY:             'Available',
  SCHEDULED_LED:     'Scheduled',
  HOLD_TENTATIVE:    RESERVATION_LABEL,
  COMMITTED_NOT_SET: COMMITTED_LABEL,
  ATT_SOFT:          'ATT Soft Hold',
  MAINTENANCE:       'Under Maintenance',
}

export function CellDetail({ cell, lastKnownMarket, onClose, onHoldDeleted }: CellDetailProps) {

  const handleRelease = async () => {
    if (!cell?.hold_id) return
    const msg = cell.display_status === 'ATT_SOFT'
      ? 'Release this AT&T soft hold for the whole month?'
      : 'Release this hold?'
    if (!confirm(msg)) return
    const res = await fetch(`/api/holds/${cell.hold_id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success('Hold released')
      onHoldDeleted()
    } else {
      const err = await res.json()
      toast.error(err.error || 'Failed to release hold')
    }
  }

  const handleUpgrade = async () => {
    if (!cell?.hold_id) return
    const res = await fetch(`/api/holds/${cell.hold_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'COMMITTED' }),
    })
    if (res.ok) {
      toast.success('Marked committed (won)')
      onHoldDeleted()
    } else {
      const err = await res.json()
      toast.error(err.error || 'Failed to mark committed')
    }
  }

  // ── Empty state (nothing selected) ───────────────────────────────────────
  if (!cell) {
    return (
      <div className="w-56 flex-shrink-0 border border-gray-200 rounded-lg bg-white flex flex-col items-center justify-center text-center p-6 gap-3 text-gray-400 h-fit min-h-[200px] sticky top-0">
        <div className="text-3xl">📋</div>
        <div className="text-sm font-medium text-gray-500">No cell selected</div>
        <div className="text-xs leading-relaxed">
          Click any cell to see details.
          <br />
          Drag across cells to place a hold.
        </div>
      </div>
    )
  }

  // ── Populated state ───────────────────────────────────────────────────────
  const status    = cell.display_status
  const dateStr   = cell.calendar_date ? format(parseISO(cell.calendar_date + 'T12:00:00'), 'MMM d, yyyy') : ''
  const market    = cell.hold_market || cell.market || lastKnownMarket
  const isHold        = status === 'HOLD_TENTATIVE' || status === 'COMMITTED_NOT_SET'
  const isHoldRequest = status === 'HOLD_REQUEST'
  const isScheduled   = status === 'SCHEDULED_LED'
  const isATTSoft     = status === 'ATT_SOFT'
  const isMaintenance = status === 'MAINTENANCE'

  return (
    <div className="w-56 flex-shrink-0 border border-gray-200 rounded-lg bg-white flex flex-col overflow-hidden sticky top-0 h-fit">

      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-base font-bold text-gray-900 truncate">Truck {cell.truck_number}</div>
          <div className="text-xs text-gray-400 mt-0.5">{dateStr}</div>
        </div>
        <button
          onClick={onClose}
          className="text-gray-300 hover:text-gray-500 text-lg leading-none flex-shrink-0 mt-0.5"
          title="Close panel"
        >
          ×
        </button>
      </div>

      {/* Status badge */}
      <div className="px-4 pt-3">
        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[status] ?? STATUS_BADGE.EMPTY}`}>
          {STATUS_LABELS[status] ?? status}
        </span>
      </div>

      {/* Details */}
      <div className="px-4 pt-3 pb-4 space-y-2 text-sm flex-1">

        {/* Scheduled cell details */}
        {isScheduled && (
          <>
            {cell.program              && <Row label="Program"    value={cell.program} />}
            {market                    && <Row label="Market"     value={market} />}
            <Row label="Std Market" value={cell.standard_market_name ?? ''} alwaysShow />
            {cell.shift_start && (
              <Row label="Dates" value={`${formatDate(cell.shift_start)} – ${formatDate(cell.shift_end ?? '')}`} />
            )}
          </>
        )}

        {/* Hold / committed details */}
        {isHold && (
          <>
            {status === 'HOLD_TENTATIVE' && (
              <button
                onClick={handleUpgrade}
                className="w-full bg-gray-200 hover:bg-gray-300 text-gray-800 text-sm py-2 rounded-lg font-medium transition-colors"
              >
                Mark committed (won)
              </button>
            )}
            {cell.client_name   && <Row label="Client"  value={cell.client_name} />}
            {market             && <Row label="Market"  value={market} />}
            {cell.hold_notes    && <Row label="Notes"   value={cell.hold_notes} />}
            {cell.hold_created_by && <Row label="By"    value={cell.hold_created_by} />}
            {cell.hold_origination === 'mcp' && <Row label="Via" value="MCP" />}
          </>
        )}

        {/* ATT soft hold details */}
        {isATTSoft && (
          <>
            {cell.client_name && <Row label="Client" value={cell.client_name} />}
            {cell.hold_notes  && <Row label="Period" value={cell.hold_notes} />}
          </>
        )}

        {/* Client hold request details */}
        {isHoldRequest && (
          <>
            {cell.client_name && <Row label="Client"  value={cell.client_name} />}
            {cell.hold_notes  && <Row label="Notes"   value={cell.hold_notes} />}
          </>
        )}

        {/* Maintenance details */}
        {isMaintenance && (
          <>
            <div className="flex items-start gap-2 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2.5">
              <span className="text-orange-500 text-base leading-none mt-0.5">⚠</span>
              <p className="text-xs text-orange-800 font-medium leading-relaxed">
                This truck is under maintenance. Holds cannot be placed during this period.
              </p>
            </div>
            {cell.shift_start && (
              <Row label="Period" value={`${formatDate(cell.shift_start)} – ${formatDate(cell.shift_end ?? '')}`} />
            )}
          </>
        )}

        {/* Available cell — show last known market if any */}
        {status === 'EMPTY' && lastKnownMarket && (
          <Row label="Available in" value={lastKnownMarket} />
        )}

        {/* GPS address for all statuses */}
        {cell.formatted_location && (
          <Row label="Last GPS" value={cell.formatted_location} />
        )}
      </div>

      {/* Action buttons */}
      <div className="px-4 pb-4 flex flex-col gap-2">
        {/* Hold management buttons */}
        {isHold && (
          <>
            {status === 'HOLD_TENTATIVE' && (
              <button
                onClick={handleUpgrade}
                className="w-full bg-gray-200 hover:bg-gray-300 text-gray-800 text-sm py-2 rounded-lg font-medium transition-colors"
              >
                Mark committed (won)
              </button>
            )}
            <button
              onClick={handleRelease}
              className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm py-2 rounded-lg font-medium transition-colors"
            >
              Release Reservation
            </button>
          </>
        )}

        {/* ATT soft hold: release button */}
        {isATTSoft && (
          <button
            onClick={handleRelease}
            className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm py-2 rounded-lg font-medium transition-colors"
          >
            Release ATT Hold
          </button>
        )}

        {/* Scheduled: read-only, no hold action */}
        {isScheduled && (
          <p className="text-xs text-gray-400 text-center">
            Scheduled in LED app — holds disabled
          </p>
        )}

        {/* Maintenance: no hold action */}
        {isMaintenance && (
          <p className="text-xs text-orange-400 text-center font-medium">
            Holds disabled during maintenance
          </p>
        )}
      </div>
    </div>
  )
}

function Row({ label, value, alwaysShow }: { label: string; value: string; alwaysShow?: boolean }) {
  if (!value && !alwaysShow) return null
  return (
    <div className="flex gap-2 items-start">
      <span className="text-gray-400 text-xs w-20 flex-shrink-0 pt-0.5">{label}</span>
      <span className="text-gray-800 font-medium text-xs leading-relaxed break-words min-w-0">{value}</span>
    </div>
  )
}

function formatDate(t: string): string {
  if (!t) return ''
  try { return format(parseISO(t + 'T12:00:00'), 'MMM d, yyyy') } catch { return t }
}

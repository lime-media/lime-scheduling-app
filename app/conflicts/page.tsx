'use client'

/**
 * Conflicts — every booking problem, each listed once, in one of three
 * sections:
 *
 *   1. On an LED program    a reservation overlaps a scheduled program
 *                           (dbo.schedule_conflicts: one row per reservation
 *                           × program block, over a date range)
 *   2. On an AT&T soft hold a reservation sits on days reserved for AT&T
 *                           (components/AttSoftConflicts.tsx)
 *   3. Cannot be served     the truck cannot get there, would strand its next
 *                           job, or is double-booked with another reservation
 *                           (/api/holds/infeasible)
 *
 * The audit behind section 3 also flags a reservation on an LED program or a
 * soft hold as "booked"; those are left out here because sections 1 and 2
 * already list them, with the actions that fit.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { Navbar } from '@/components/Navbar'
import { AttSoftConflicts } from '@/components/AttSoftConflicts'
import { SortableTh, useTableSort } from '@/components/SortableTh'
import { sortRows, type SortValue } from '@/lib/tableSort'

type InfeasibleHold = {
  holdId:       string
  truckNumber:  string
  clientName:   string
  market:       string
  startDate:    string
  endDate:      string
  status:       string
  origination:  string
  source:       string
  reason:       string
  detail:       string
  overridable:  boolean
  clashWith?:   'RESERVATION' | 'SCHEDULE' | 'SOFT_HOLD'
}

const REASON_LABELS: Record<string, string> = {
  CANNOT_ARRIVE:     'Cannot arrive in time',
  STRANDS_SUCCESSOR: 'Strands a later booking',
  UNKNOWN_ORIGIN:    'No known location',
  BOOKED:            'Double-booked with another reservation',
}

type Conflict = {
  id:                string
  hold_id:           string
  truck_number:      string
  conflict_start:    string
  conflict_end:      string
  hold_client:       string
  hold_market:       string
  scheduled_program: string
  status:            string
  detected_at:       string
  hold_start:        string | null
  hold_end:          string | null
  hold_status:       string | null
  hold_source:       string | null
}

const fmt = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const range = (a: string, b: string) => (a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`)
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1

function relativeTime(iso: string): string {
  const diffMs   = Date.now() - new Date(iso).getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1)  return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHrs = Math.floor(diffMins / 60)
  if (diffHrs < 24)  return `${diffHrs}h ago`
  return `${Math.floor(diffHrs / 24)}d ago`
}

const TH = 'px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider'

const CONFLICT_COLUMNS = [
  { key: 'truck', label: 'Truck' },
  { key: 'reservation', label: 'Reservation' },
  { key: 'program', label: 'LED program' },
  { key: 'dates', label: 'Overlap' },
  { key: 'detected', label: 'Detected' },
] as const
type ConflictKey = typeof CONFLICT_COLUMNS[number]['key']
const conflictValue = (c: Conflict, key: ConflictKey): SortValue => ({
  truck: c.truck_number, reservation: c.hold_client, program: c.scheduled_program,
  dates: `${c.conflict_start} ${c.conflict_end}`, detected: c.detected_at,
})[key]

const INFEASIBLE_COLUMNS = [
  { key: 'truck', label: 'Truck' },
  { key: 'reservation', label: 'Reservation' },
  { key: 'dates', label: 'Dates' },
  { key: 'problem', label: 'Problem' },
] as const
type InfeasibleKey = typeof INFEASIBLE_COLUMNS[number]['key']
const infeasibleValue = (h: InfeasibleHold, key: InfeasibleKey): SortValue => ({
  truck: h.truckNumber, reservation: h.clientName, dates: `${h.startDate} ${h.endDate}`,
  problem: REASON_LABELS[h.reason] ?? h.reason,
})[key]

/** Section 3 lists only what sections 1 and 2 do not. */
const ownSection = (h: InfeasibleHold) => h.reason !== 'BOOKED' || h.clashWith === 'RESERVATION'

function SectionHeader({ n, title, count, tone, children }: { n: number; title: string; count: number | null; tone: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-bold text-gray-900">{n}. {title}</h2>
        {count !== null && count > 0 && <span className={`${tone} text-white text-xs font-bold px-2 py-0.5 rounded-full`}>{count}</span>}
      </div>
      <p className="text-sm text-gray-500 mt-1">{children}</p>
    </div>
  )
}

export default function ConflictsPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const [loading,   setLoading]   = useState(true)
  const [acting,    setActing]    = useState<string | null>(null)   // id of row being acted on
  // Holds that cannot actually be served. Mostly Salesforce and ATT sync
  // writes, which bypass the feasibility gate on purpose — plus anything that
  // became impossible after a neighbouring job moved.
  const [infeasible,        setInfeasible]        = useState<InfeasibleHold[]>([])
  const [infeasibleLoading, setInfeasibleLoading] = useState(true)
  // A failed audit must never render as "nothing to report" — this is the one
  // table whose job is catching unservable bookings.
  const [infeasibleError, setInfeasibleError] = useState<string | null>(null)
  // Data-quality signals from the same audit: markets that do not geocode.
  const [dataGaps, setDataGaps] = useState<{ gpsFallbacks: { holdId: string; priorMarket: string }[]; unresolvedMarkets: { holdId: string; market: string }[] }>({ gpsFallbacks: [], unresolvedMarkets: [] })
  // Bumped on Refresh so the AT&T section reloads with the rest.
  const [refreshKey, setRefreshKey] = useState(0)
  const [attCount, setAttCount] = useState<number | null>(null)

  const conflictSort = useTableSort<ConflictKey>('conflicts.sort.schedule', CONFLICT_COLUMNS.map(c => c.key))
  const infeasibleSort = useTableSort<InfeasibleKey>('conflicts.sort.infeasible', INFEASIBLE_COLUMNS.map(c => c.key))
  const sortedConflicts = useMemo(() => sortRows(conflicts, conflictSort.sort, conflictValue), [conflicts, conflictSort.sort])
  const unservable = useMemo(() => infeasible.filter(ownSection), [infeasible])
  const sortedInfeasible = useMemo(() => sortRows(unservable, infeasibleSort.sort, infeasibleValue), [unservable, infeasibleSort.sort])

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  const fetchConflicts = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/conflicts')
      if (res.ok) {
        const data = await res.json()
        setConflicts(data.conflicts ?? [])
      }
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [])

  const fetchInfeasible = useCallback(async () => {
    setInfeasibleLoading(true)
    setInfeasibleError(null)
    try {
      const res = await fetch('/api/holds/infeasible')
      if (!res.ok) {
        setInfeasibleError(`Audit failed (${res.status}). This list may be incomplete.`)
      }
      if (res.ok) {
        const data = await res.json()
        setInfeasible(data.infeasible ?? [])
        setDataGaps({
          gpsFallbacks: data.gpsFallbacks ?? [],
          unresolvedMarkets: data.unresolvedMarkets ?? [],
        })
      }
    } catch {
      setInfeasibleError('Audit could not run. This list may be incomplete.')
    } finally {
      setInfeasibleLoading(false)
    }
  }, [])

  useEffect(() => { fetchConflicts() }, [fetchConflicts])
  useEffect(() => { fetchInfeasible() }, [fetchInfeasible])

  const act = async (c: Conflict, action: 'resolve' | 'release-hold') => {
    if (action === 'release-hold' && !confirm(`Release ${c.hold_client}'s reservation on truck ${c.truck_number}${c.hold_start && c.hold_end ? ` (${range(c.hold_start, c.hold_end)})` : ''}? The truck stays on ${c.scheduled_program}.`)) return
    setActing(c.id)
    try {
      const res = await fetch(`/api/conflicts/${c.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action }),
      })
      if (res.ok) {
        toast.success(action === 'resolve' ? 'Dismissed. These dates will not be flagged again.' : 'Reservation released')
        fetchConflicts()
        if (action === 'release-hold') fetchInfeasible()
      } else {
        const err = await res.json()
        toast.error(err.error || 'Action failed')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setActing(null)
    }
  }

  if (status === 'loading' || !session) return null

  const total = conflicts.length + (attCount ?? 0) + unservable.length

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-gray-50">
      <Navbar />

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-7xl mx-auto">

          {/* Header and summary: one count per section, nothing counted twice */}
          <div className="flex items-start justify-between gap-4 mb-8">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Conflicts</h1>
              <p className="text-sm text-gray-500 mt-1">
                {loading || infeasibleLoading || attCount === null
                  ? 'Checking…'
                  : total === 0
                    ? 'Nothing needs attention.'
                    : `${total} to review: ${conflicts.length} on an LED program, ${attCount} on an AT&T soft hold, ${unservable.length} cannot be served. Each appears once.`}
              </p>
            </div>
            <button
              onClick={() => { fetchConflicts(); fetchInfeasible(); setRefreshKey(k => k + 1) }}
              className="text-xs text-green-700 hover:text-green-900 font-medium border border-green-200 px-2 py-1 rounded-lg transition-colors"
            >
              Refresh
            </button>
          </div>

          {/* ---- 1. Reservations on an LED program ------------------------ */}
          <SectionHeader n={1} title="On an LED program" count={conflicts.length} tone="bg-red-500">
            A reservation overlaps a program the truck is scheduled for. One row per reservation and program, over the days they overlap.
            Release the reservation, or dismiss if both are right (e.g. the LED schedule is about to change); dismissed dates are not flagged again.
          </SectionHeader>
          {loading ? (
            <div className="flex justify-center py-10">
              <div className="w-6 h-6 border-2 border-green-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : conflicts.length === 0 ? (
            <div className="text-sm text-gray-500 bg-white border border-gray-200 rounded-xl px-4 py-6 text-center">No reservation overlaps an LED program.</div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
              <table className="w-full text-sm">
                <thead className="bg-gray-50/80 border-b border-gray-200">
                  <tr>
                    {CONFLICT_COLUMNS.map(c => (
                      <SortableTh key={c.key} label={c.label} sortKey={c.key} sort={conflictSort.sort} onSort={conflictSort.sortBy} className={TH} />
                    ))}
                    <SortableTh label="" sort={conflictSort.sort} onSort={conflictSort.sortBy} className={TH} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sortedConflicts.map((c) => (
                    <tr key={c.id} className="hover:bg-red-50/30 transition-colors align-top">
                      <td className="px-4 py-3 font-semibold text-gray-800 tabular-nums">{c.truck_number}</td>
                      <td className="px-4 py-3 text-gray-700">
                        <div>{c.hold_client}{c.hold_market ? ` · ${c.hold_market}` : ''}</div>
                        {c.hold_start && c.hold_end && (
                          <div className="text-xs text-gray-500">
                            {range(c.hold_start, c.hold_end)}
                            {c.hold_status === 'COMMITTED' ? ' · Committed (won)' : ' · Reservation'}
                            {c.hold_source ? ` · from ${c.hold_source.toLowerCase()}` : ''}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-700">{c.scheduled_program}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded-lg text-xs font-medium">
                          {range(c.conflict_start, c.conflict_end)}
                        </span>
                        <span className="ml-1.5 text-xs text-gray-500">{days(c.conflict_start, c.conflict_end)} day{days(c.conflict_start, c.conflict_end) === 1 ? '' : 's'}</span>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{relativeTime(c.detected_at)}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 justify-end">
                          <button
                            disabled={acting === c.id}
                            onClick={() => act(c, 'release-hold')}
                            className="text-xs px-2.5 py-1 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-40 transition-colors whitespace-nowrap"
                          >
                            Release reservation
                          </button>
                          <button
                            disabled={acting === c.id}
                            onClick={() => act(c, 'resolve')}
                            title="Keep both; stop flagging these dates"
                            className="text-xs px-2.5 py-1 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-100 disabled:opacity-40 transition-colors"
                          >
                            Dismiss
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ---- 2. Reservations on an AT&T soft hold --------------------- */}
          <AttSoftConflicts key={refreshKey} onCount={setAttCount} />

          {/* ---- 3. Cannot be served -------------------------------------- */}
          <div className="mt-10">
            <SectionHeader n={3} title="Cannot be served" count={infeasibleLoading ? null : unservable.length} tone="bg-amber-500">
              The truck cannot reach the market in time, would strand its next booking, or is double-booked with another reservation.
              Salesforce and the AT&amp;T sync write reservations without this check on purpose, so they surface here; one can also appear after a nearby job moves.
            </SectionHeader>
          </div>

          {/* Market names that do not resolve to coordinates. Distinct from a
              scheduling problem: these holds are priced on the wrong basis and
              nothing else will surface it. */}
          {(dataGaps.gpsFallbacks.length > 0 || dataGaps.unresolvedMarkets.length > 0) && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm">
              <p className="font-semibold text-red-800">Market names not recognized</p>
              {dataGaps.gpsFallbacks.length > 0 && (
                <p className="text-red-700 mt-1">
                  <span className="font-medium">{dataGaps.gpsFallbacks.length} hold{dataGaps.gpsFallbacks.length !== 1 ? 's' : ''}</span> priced from GPS instead of the prior job, because that job&apos;s market could not be matched:{' '}
                  {[...new Set(dataGaps.gpsFallbacks.map(g => g.priorMarket))].join('; ')}
                </p>
              )}
              {dataGaps.unresolvedMarkets.length > 0 && (
                <p className="text-red-700 mt-1">
                  <span className="font-medium">{dataGaps.unresolvedMarkets.length} hold{dataGaps.unresolvedMarkets.length !== 1 ? 's' : ''}</span> not checked — market not recognized:{' '}
                  {[...new Set(dataGaps.unresolvedMarkets.map(g => g.market))].join('; ')}
                </p>
              )}
              <p className="text-red-600 text-xs mt-1.5">Add these to the market coordinate map so transport is priced from the right origin.</p>
            </div>
          )}

          {infeasibleError && (
            <div className="mb-4 bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 text-sm text-amber-900">
              <p className="font-semibold">Could not verify holds</p>
              <p className="mt-0.5">{infeasibleError}</p>
            </div>
          )}

          {infeasibleLoading ? (
            <div className="flex justify-center py-10">
              <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : unservable.length === 0 && !infeasibleError ? (
            <div className="text-sm text-gray-500 bg-white border border-gray-200 rounded-xl px-4 py-6 text-center">
              Every reservation can be served: trucks can reach their markets and make their next job.
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
              <table className="w-full text-sm">
                <thead className="bg-gray-50/80 border-b border-gray-200">
                  <tr>
                    {INFEASIBLE_COLUMNS.map(c => (
                      <SortableTh key={c.key} label={c.label} sortKey={c.key} sort={infeasibleSort.sort} onSort={infeasibleSort.sortBy} className={TH} />
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sortedInfeasible.map((h) => (
                    <tr key={h.holdId} className="hover:bg-amber-50/30 transition-colors align-top">
                      <td className="px-4 py-3 font-semibold text-gray-800 tabular-nums">{h.truckNumber}</td>
                      <td className="px-4 py-3 text-gray-700">
                        <div>{h.clientName}{h.market ? ` · ${h.market}` : ''}</div>
                        <div className="text-xs text-gray-500">
                          {h.status === 'COMMITTED' ? 'Committed (won)' : 'Reservation'} · from {h.source.toLowerCase()}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{range(h.startDate, h.endDate)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
                          h.overridable ? 'bg-purple-100 text-purple-800' : 'bg-amber-100 text-amber-800'
                        }`}>
                          {REASON_LABELS[h.reason] ?? h.reason}
                        </span>
                        {h.overridable && (
                          <span className="ml-1.5 text-xs text-purple-600">resolvable by releasing a soft hold</span>
                        )}
                        <p className="text-xs text-gray-500 mt-1 max-w-xl">{h.detail}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

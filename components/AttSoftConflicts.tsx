'use client'

/**
 * Conflicts page — AT&T soft holds that still clash with a reservation.
 * Each row can be released for that booking's dates (with the operations
 * warning) or dismissed when operations is not concerned. Both are recorded.
 */

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { ATT_RELEASE_WARNING } from '@/lib/attSoftRules'

type Row = {
  key: string
  softHoldId: string
  reservationId: string
  truckNumber: string
  softHold: { start: string; end: string }
  reservation: { start: string; end: string; status: string; source: string; client: string; market: string; createdBy: string | null }
  overlap: { start: string; end: string }
}

const fmt = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const range = (a: string, b: string) => (a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`)

type Release = { id: string; truckNumber: string; start: string; end: string; by: string | null; at: string; notes: string }

export function AttSoftConflicts() {
  const [releases, setReleases] = useState<Release[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/holds/att-soft/conflicts')
      if (!res.ok) throw new Error(`Check failed (${res.status}). This list may be incomplete.`)
      setRows((await res.json()).conflicts ?? [])
      const rel = await fetch('/api/holds/att-soft/releases')
      if (rel.ok) setReleases((await rel.json()).releases ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check failed. This list may be incomplete.')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  const release = async (r: Row) => {
    if (!confirm(ATT_RELEASE_WARNING)) return
    setBusy(r.key)
    try {
      const res = await fetch('/api/holds/att-soft/release', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          truck_number: r.truckNumber, start_date: r.overlap.start, end_date: r.overlap.end,
          context: `Conflicts review: ${r.reservation.client}, ${r.reservation.market}, ${r.reservation.start} to ${r.reservation.end}`,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Release failed')
      toast.success(data.message)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Release failed')
    } finally {
      setBusy(null)
    }
  }

  const undo = async (r: Release) => {
    if (!confirm(`Undo this release? Truck ${r.truckNumber} ${range(r.start, r.end)} goes back to AT&T at the next sync, if nothing else is booked there.`)) return
    setBusy(r.id)
    try {
      const res = await fetch(`/api/holds/att-soft/release?id=${encodeURIComponent(r.id)}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Undo failed')
      toast.success(data.message)
      setReleases(prev => prev.filter(x => x.id !== r.id))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Undo failed')
    } finally {
      setBusy(null)
    }
  }

  const dismiss = async (r: Row) => {
    setBusy(r.key)
    try {
      const res = await fetch('/api/holds/att-soft/conflicts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ softHoldId: r.softHoldId, reservationId: r.reservationId }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Dismiss failed')
      setRows(prev => prev.filter(x => x.key !== r.key))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Dismiss failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="mt-10">
      <div className="flex items-center gap-3 mb-1">
        <h2 className="text-xl font-bold text-gray-900">AT&amp;T Soft Holds With a Conflict</h2>
        {rows.length > 0 && <span className="bg-blue-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">{rows.length}</span>}
      </div>
      <p className="text-sm text-gray-500 mb-4">
        A reservation sits on days reserved for AT&amp;T. Release the soft hold for that booking&apos;s dates once operations agrees, or dismiss it if you are not concerned.
      </p>
      {error && <div className="mb-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">{error}</div>}
      {loading ? (
        <div className="text-sm text-gray-500">Checking…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-gray-500 bg-white border border-gray-200 rounded-xl px-4 py-6 text-center">No AT&amp;T soft hold has a conflict.</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50/80 border-b border-gray-200">
              <tr>
                {['Truck', 'Conflict dates', 'Reservation', 'AT&T soft hold', ''].map(h => (
                  <th key={h} className="text-left px-4 py-3 font-semibold text-gray-500 text-xs uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map(r => (
                <tr key={r.key} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900 tabular-nums">#{r.truckNumber}</td>
                  <td className="px-4 py-3 text-gray-800 whitespace-nowrap">{range(r.overlap.start, r.overlap.end)}</td>
                  <td className="px-4 py-3 text-gray-700">
                    <div>{r.reservation.client}{r.reservation.market ? ` · ${r.reservation.market}` : ''}</div>
                    <div className="text-xs text-gray-500">
                      {range(r.reservation.start, r.reservation.end)} · {r.reservation.status === 'COMMITTED' ? 'Committed (won)' : 'Reservation'} · from {r.reservation.source.toLowerCase()}{r.reservation.createdBy ? ` · ${r.reservation.createdBy}` : ''}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{range(r.softHold.start, r.softHold.end)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 justify-end">
                      <button onClick={() => release(r)} disabled={busy === r.key}
                        className="rounded border border-blue-300 bg-white px-2.5 py-1 text-xs font-medium text-blue-900 hover:bg-blue-50 disabled:opacity-50">
                        Release for this booking
                      </button>
                      <button onClick={() => dismiss(r)} disabled={busy === r.key}
                        className="rounded border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                        title="Hide this alert; recorded with your name">
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

      <div className="mt-8">
        <h3 className="text-base font-semibold text-gray-900 mb-1">Released AT&amp;T soft holds</h3>
        <p className="text-sm text-gray-500 mb-3">Dates released for a booking, still in effect. Undo puts them back to AT&amp;T at the next sync.</p>
        {releases.length === 0 ? (
          <div className="text-sm text-gray-500 bg-white border border-gray-200 rounded-xl px-4 py-4 text-center">No releases in effect.</div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50/80 border-b border-gray-200">
                <tr>
                  {['Truck', 'Released dates', 'For', 'By', ''].map(h => (
                    <th key={h} className="text-left px-4 py-3 font-semibold text-gray-500 text-xs uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {releases.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900 tabular-nums">#{r.truckNumber}</td>
                    <td className="px-4 py-3 text-gray-800 whitespace-nowrap">{range(r.start, r.end)}</td>
                    <td className="px-4 py-3 text-gray-600">{r.notes.replace(/^AT&T soft hold released for /, '').replace(/ by [^.]*\.$/, '')}</td>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{r.by ?? '—'} · {new Date(r.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => undo(r)} disabled={busy === r.id}
                        className="rounded border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                        Undo
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

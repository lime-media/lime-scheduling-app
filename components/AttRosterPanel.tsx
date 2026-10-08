'use client'

/**
 * The AT&T truck list's manual changes, on the Reservations page's AT&T Soft
 * filter: what is in effect, add a truck / take one off for a date range,
 * and undo. The list is otherwise automatic (lib/attSoftHolds.ts); each
 * change ends on its end date, then the automatic rule applies again.
 */

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { format } from 'date-fns'
import { parseDateOnly } from '@/lib/dateOnly'
import { validateRosterOverride } from '@/lib/attSoftRules'

export type RosterDraft = { action: 'ADD' | 'REMOVE'; truck_number: string; start: string; end: string; reason: string }

type Override = { id: string; truck_number: string; action: 'ADD' | 'REMOVE'; start_date: string; end_date: string; reason: string; created_by_name: string }

const today = () => new Date().toISOString().slice(0, 10)
const monthEnd = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10) }
const fmt = (s: string) => format(parseDateOnly(s), 'MMM d, yyyy')

/** A fresh draft: added from today to the end of this month. */
export const newAddDraft = (): RosterDraft => ({ action: 'ADD', truck_number: '', start: today(), end: monthEnd(), reason: '' })

export function AttRosterPanel({ draft, setDraft, onChanged }: {
  draft: RosterDraft | null
  setDraft: (d: RosterDraft | null) => void
  /** Called after a change, so the soft-hold rows reload. */
  onChanged: () => void
}) {
  const [overrides, setOverrides] = useState<Override[]>([])
  const [trucks, setTrucks] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch('/api/holds/att-soft/roster')
    if (res.ok) setOverrides((await res.json()).overrides ?? [])
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    fetch('/api/trucks').then(r => (r.ok ? r.json() : [])).then((rows: { truck_number: string }[]) => setTrucks(rows.map(r => String(r.truck_number)))).catch(() => undefined)
  }, [])

  const error = draft
    ? (!draft.truck_number.trim() ? 'Choose a truck.' : validateRosterOverride({ ...draft }, today()))
    : null

  const done = (data: { message?: string; warning?: string | null }) => {
    toast.success(data.message ?? 'Saved')
    if (data.warning) toast(data.warning, { icon: '⚠️', duration: 8000 })
    load()
    onChanged()
  }

  const save = async () => {
    if (!draft || error) return
    setSaving(true)
    try {
      const res = await fetch('/api/holds/att-soft/roster', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ truck_number: draft.truck_number.trim(), action: draft.action, start_date: draft.start, end_date: draft.end, reason: draft.reason }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not save')
      setDraft(null)
      done(data)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const undo = async (o: Override) => {
    if (!confirm(`Undo: truck ${o.truck_number} goes back to the automatic AT&T rule for ${fmt(o.start_date)} – ${fmt(o.end_date)}.`)) return
    const res = await fetch(`/api/holds/att-soft/roster?id=${encodeURIComponent(o.id)}`, { method: 'DELETE' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { toast.error(data.error || 'Could not undo'); return }
    done(data)
  }

  return (
    <div className="mb-6 bg-white border border-blue-200 rounded-xl">
      <div className="px-4 py-3 flex items-start justify-between gap-3 border-b border-blue-100">
        <div>
          <p className="text-sm font-semibold text-gray-900">AT&amp;T truck list</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Automatic: trucks with more than 5 days of 160over90 work this month. Changes below override that until their end date.
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button onClick={() => setDraft(newAddDraft())}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-blue-200 text-blue-700 hover:bg-blue-50 transition-colors">
            Add a truck
          </button>
          <button onClick={() => setDraft({ ...newAddDraft(), action: 'REMOVE' })}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors">
            Take a truck off
          </button>
        </div>
      </div>
      {overrides.length === 0 ? (
        <p className="px-4 py-3 text-xs text-gray-400">No manual changes in effect.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {overrides.map(o => (
            <li key={o.id} className="px-4 py-2 flex items-center gap-3 text-sm">
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${o.action === 'ADD' ? 'bg-blue-100 text-blue-800' : 'bg-gray-200 text-gray-700'}`}>
                {o.action === 'ADD' ? 'ADDED' : 'TAKEN OFF'}
              </span>
              <span className="font-semibold text-gray-900">{o.truck_number}</span>
              <span className="text-gray-600">{fmt(o.start_date)} – {fmt(o.end_date)}</span>
              <span className="flex-1 text-xs text-gray-500 truncate" title={o.reason}>{o.reason}{o.created_by_name ? ` · ${o.created_by_name}` : ''}</span>
              <button onClick={() => undo(o)} className="text-xs font-medium text-gray-500 hover:text-gray-800">Undo</button>
            </li>
          ))}
        </ul>
      )}

      {draft && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-lg font-bold text-gray-900">
                {draft.action === 'ADD' ? 'Add a truck to the AT&T list' : 'Take a truck off the AT&T list'}
              </h2>
              <p className="text-sm text-gray-500 mt-0.5">
                {draft.action === 'ADD'
                  ? 'It gets AT&T soft holds on these dates, like AT&T’s own trucks.'
                  : 'Its AT&T soft holds on these dates are released, and none are made there.'}
                {' '}After the end date the automatic rule applies again.
              </p>
            </div>
            <div className="px-6 py-4 space-y-3">
              <label className="block text-xs font-medium text-gray-600">
                Truck
                <input type="text" list="att-roster-trucks" value={draft.truck_number}
                  onChange={e => setDraft({ ...draft, truck_number: e.target.value })}
                  className="mt-1 w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
                <datalist id="att-roster-trucks">
                  {trucks.map(t => <option key={t} value={t} />)}
                </datalist>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-medium text-gray-600">
                  From
                  <input type="date" value={draft.start} onChange={e => setDraft({ ...draft, start: e.target.value })}
                    className="mt-1 w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
                </label>
                <label className="text-xs font-medium text-gray-600">
                  Through
                  <input type="date" value={draft.end} min={draft.start || undefined} onChange={e => setDraft({ ...draft, end: e.target.value })}
                    className="mt-1 w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
                </label>
              </div>
              <label className="block text-xs font-medium text-gray-600">
                Why
                <input type="text" value={draft.reason} maxLength={500}
                  placeholder={draft.action === 'ADD' ? 'e.g. replacing 1043 for AT&T in Dallas' : 'e.g. swapped out for 1102; going to Acme'}
                  onChange={e => setDraft({ ...draft, reason: e.target.value })}
                  className="mt-1 w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
              </label>
              {error && draft.truck_number && <p className="text-xs text-red-600">{error}</p>}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
              <button onClick={() => setDraft(null)}
                className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2.5 text-sm font-medium hover:bg-gray-50 transition-colors">
                Cancel
              </button>
              <button onClick={save} disabled={saving || Boolean(error)}
                className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors">
                {saving ? 'Saving...' : draft.action === 'ADD' ? 'Add to list' : 'Take off list'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

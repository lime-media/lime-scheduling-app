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
import { softHoldWindow, validateRosterOverride } from '@/lib/attSoftRules'

export type RosterDraft = { action: 'ADD' | 'REMOVE'; truck_number: string; start: string; end: string; reason: string }

type Pending = {
  reason: string
  at: string
  months: { current: string; prior: string | null }
  trucks: { truck_number: string; holds: number; current: number; prior: number }[]
}

const monthLabel = (ym: string) => format(parseDateOnly(`${ym}-01`), 'MMM yyyy')

/**
 * The release the safety valve held back (lib/attSoftHolds.ts), with a way
 * to approve it when it is right — an AT&T program ending, say.
 */
function HeldBackRelease({ onChanged }: { onChanged: () => void }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [reason, setReason] = useState('')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch('/api/holds/att-soft/mass-release')
    const p: Pending | null = res.ok ? (await res.json()).pending : null
    setPending(p)
  }, [])
  useEffect(() => { load() }, [load])

  if (!pending || pending.trucks.length === 0) return null

  // All or nothing: a truck left out would just be released by the normal
  // rule as a small drop. Keeping one is done by adding it to the AT&T list.
  const trucks = pending.trucks.map(t => t.truck_number)
  const holds = pending.trucks.reduce((n, t) => n + t.holds, 0)

  const approve = async () => {
    if (!reason.trim()) return
    if (!confirm(`Release ${holds} AT&T soft hold${holds === 1 ? '' : 's'} on ${trucks.length} truck${trucks.length === 1 ? '' : 's'}? They go back into the general pool. If AT&T books them again, they return to the list automatically.`)) return
    setSaving(true)
    try {
      const res = await fetch('/api/holds/att-soft/mass-release', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trucks, reason }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not approve')
      toast.success(data.message)
      if (Array.isArray(data.warnings) && data.warnings.length) toast(data.warnings.join('\n'), { icon: '⚠️', duration: 10000 })
      setOpen(false)
      setReason('')
      load()
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not approve')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="px-4 py-3 border-b border-amber-200 bg-amber-50">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm text-amber-900">
          <p className="font-semibold">
            {pending.trucks.length} truck{pending.trucks.length === 1 ? '' : 's'} no longer count as AT&amp;T&apos;s, but their soft holds were kept
          </p>
          <p className="text-xs text-amber-800 mt-0.5">
            The safety check held the release back ({pending.reason}). If an AT&amp;T program ended, approve it. If not, check the 160over90 schedule and client record.
          </p>
        </div>
        <button onClick={() => setOpen(o => !o)}
          className="flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border border-amber-300 text-amber-900 bg-white hover:bg-amber-100">
          {open ? 'Hide' : 'Review'}
        </button>
      </div>
      {open && (
        <div className="mt-3">
          <div className="max-h-64 overflow-auto bg-white border border-amber-200 rounded-lg">
            <table className="w-full text-xs">
              <thead className="bg-amber-50 sticky top-0">
                <tr className="text-left text-amber-900">
                  <th className="px-3 py-1.5">Truck</th>
                  {pending.months.prior && <th className="px-3 py-1.5">160over90 days, {monthLabel(pending.months.prior)}</th>}
                  <th className="px-3 py-1.5">160over90 days, {monthLabel(pending.months.current)}</th>
                  <th className="px-3 py-1.5">Soft holds</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-amber-100">
                {pending.trucks.map(t => (
                  <tr key={t.truck_number}>
                    <td className="px-3 py-1 font-semibold text-gray-900">{t.truck_number}</td>
                    {pending.months.prior && <td className="px-3 py-1 text-gray-700">{t.prior}</td>}
                    <td className="px-3 py-1 text-gray-700">{t.current}</td>
                    <td className="px-3 py-1 text-gray-700">{t.holds}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-amber-800">
            To keep any of these trucks reserved for AT&amp;T, use <span className="font-medium">Add a truck</span> above first; then approve the rest.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input type="text" value={reason} maxLength={300} onChange={e => setReason(e.target.value)}
              placeholder='Why, e.g. "Alloy Build ended"'
              className="flex-1 min-w-[14rem] border border-amber-200 rounded-lg px-2 py-1.5 text-sm bg-white" />
            <button onClick={approve} disabled={saving || !reason.trim()}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50">
              {saving ? 'Releasing…' : `Release ${holds} soft hold${holds === 1 ? '' : 's'} on ${trucks.length} truck${trucks.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

type Override = { id: string; truck_number: string; action: 'ADD' | 'REMOVE'; start_date: string; end_date: string; reason: string; created_by_name: string }

const today = () => new Date().toISOString().slice(0, 10)
/** The last day AT&T soft holds are kept for: the end of the sync's three-month window. */
export const softHoldWindowEnd = () => { const w = softHoldWindow(today()); return w[w.length - 1].end }
const fmt = (s: string) => format(parseDateOnly(s), 'MMM d, yyyy')

/**
 * A fresh draft, from today through every month that has soft holds — a
 * change for this month only would leave the next two reserved as before.
 */
export const newAddDraft = (): RosterDraft => ({ action: 'ADD', truck_number: '', start: today(), end: softHoldWindowEnd(), reason: '' })

export function AttRosterPanel({ draft, setDraft, onChanged }: {
  draft: RosterDraft | null
  setDraft: (d: RosterDraft | null) => void
  /** Called after a change, so the soft-hold rows reload. */
  onChanged: () => void
}) {
  const [overrides, setOverrides] = useState<Override[]>([])
  const [trucks, setTrucks] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  // Bumped after any list change: the held-back release is re-read, since an
  // added truck is no longer held back.
  const [version, setVersion] = useState(0)

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
    setVersion(v => v + 1)
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
      <HeldBackRelease key={version} onChanged={() => { load(); onChanged() }} />
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

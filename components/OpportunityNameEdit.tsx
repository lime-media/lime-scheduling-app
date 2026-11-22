'use client'

import { useState } from 'react'
import toast from 'react-hot-toast'
import { OPPORTUNITY_NAME_MAX } from '@/lib/opportunityName'

/**
 * A booking's Salesforce opportunity name on Reservations, renamed in place
 * while the opportunity is open (PATCH /api/opportunities/{id}/name, which
 * re-reads the stage and refuses a closed one). The name shown comes from
 * Salesforce, so a rename made there shows here on the next load. Staff only.
 */
export function OpportunityNameEdit({ opportunityId, name, closed, onSaved }: {
  opportunityId: string
  /** As Salesforce has it; null when it couldn't be read in time. */
  name: string | null
  /** Closed in Salesforce (renamed there only); null when not known. */
  closed: boolean | null
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  // The name just saved, shown until the list reloads with it: another server
  // instance can still serve the old name from its cache for a few minutes.
  const [saved, setSaved] = useState<{ from: string | null; to: string } | null>(null)
  const shown = saved && saved.from === name ? saved.to : name

  const save = async () => {
    if (saving || !draft.trim()) return
    setSaving(true)
    try {
      const res = await fetch(`/api/opportunities/${encodeURIComponent(opportunityId)}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: draft }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(data.error ?? "The name wasn't changed"); return }
      toast.success('Opportunity renamed in Salesforce')
      if (typeof data.name === 'string') setSaved({ from: name, to: data.name })
      setEditing(false)
      onSaved()
    } catch {
      toast.error("Network error: the name wasn't changed")
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <input type="text" value={draft} maxLength={OPPORTUNITY_NAME_MAX} autoFocus aria-label="Opportunity name"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape' && !saving) setEditing(false) }}
          className="min-w-0 flex-1 border border-gray-300 rounded px-2 py-0.5 text-xs" />
        <button onClick={save} disabled={saving || !draft.trim()} className="text-xs font-medium text-green-700 hover:underline disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => setEditing(false)} disabled={saving} className="text-xs text-gray-500 hover:underline">Cancel</button>
      </span>
    )
  }
  return (
    <span className="break-words">
      {shown ?? <span className="text-gray-400">Not read from Salesforce</span>}
      {closed === false && (
        <button onClick={() => { setDraft(shown ?? ''); setEditing(true) }} className="ml-2 text-xs text-blue-700 hover:underline">Rename</button>
      )}
      {closed === true && <span className="ml-2 text-[11px] text-gray-400">closed: rename in Salesforce</span>}
    </span>
  )
}

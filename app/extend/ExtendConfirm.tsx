'use client'

import { useState } from 'react'

type Option = { days: number; date: string; label: string }

/** The button that actually extends (POST /api/extend). */
export function ExtendConfirm({ token, options, picked }: { token: string; options: Option[]; picked: number }) {
  const [days, setDays] = useState(picked)
  const [state, setState] = useState<{ kind: 'idle' | 'saving' } | { kind: 'done'; label: string; warning?: string } | { kind: 'error'; message: string }>({ kind: 'idle' })
  const chosen = options.find(o => o.days === days) ?? options[0]

  const extend = async () => {
    setState({ kind: 'saving' })
    try {
      const res = await fetch('/api/extend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, days }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setState({ kind: 'error', message: data.error ?? "Couldn't extend it." }); return }
      setState({ kind: 'done', label: chosen.label, warning: data.sfdcWarning ?? undefined })
    } catch {
      setState({ kind: 'error', message: 'Network error. Try again.' })
    }
  }

  if (state.kind === 'done') {
    return (
      <div className="space-y-2">
        <p className="text-sm text-green-800 bg-green-50 border border-green-200 rounded-lg px-3 py-2">Extended. It&apos;s now held through {state.label}, end of day (Central).</p>
        {state.warning && <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{state.warning}</p>}
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {options.map(o => (
          <button key={o.days} type="button" onClick={() => setDays(o.days)}
            className={`flex-1 px-3 py-2 rounded-lg text-sm border ${o.days === days ? 'bg-green-50 border-green-600 text-green-800 font-medium' : 'bg-white border-gray-200 text-gray-600'}`}>
            +{o.days} day{o.days > 1 ? 's' : ''}<span className="block text-xs">{o.label}</span>
          </button>
        ))}
      </div>
      <button type="button" onClick={extend} disabled={state.kind === 'saving'}
        className="w-full px-4 py-2.5 rounded-lg bg-green-600 text-white text-sm font-semibold hover:bg-green-700 disabled:opacity-50">
        {state.kind === 'saving' ? 'Extending…' : `Extend to ${chosen.label}`}
      </button>
      {state.kind === 'error' && <p className="text-sm text-red-700">{state.message}</p>}
    </div>
  )
}

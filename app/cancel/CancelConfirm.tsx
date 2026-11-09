'use client'

import { useState } from 'react'
import { CANCEL_REASON_MAX } from '@/lib/cancelReason'

/** The button that actually cancels (POST /api/cancel), with an optional reason. */
export function CancelConfirm({ token, clientEmailed, clientPortal }: { token: string; clientEmailed: boolean; clientPortal: boolean }) {
  const [reason, setReason] = useState('')
  const [state, setState] = useState<{ kind: 'idle' | 'saving' } | { kind: 'done'; emailed: boolean; warning?: string } | { kind: 'error'; message: string }>({ kind: 'idle' })

  const cancel = async () => {
    setState({ kind: 'saving' })
    try {
      const res = await fetch('/api/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, reason }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setState({ kind: 'error', message: data.error ?? "Couldn't cancel it." }); return }
      setState({ kind: 'done', emailed: data.emailed === true, warning: data.sfdcWarning ?? undefined })
    } catch {
      setState({ kind: 'error', message: 'Network error. Try again.' })
    }
  }

  if (state.kind === 'done') {
    return (
      <div className="space-y-2">
        <p className="text-sm text-green-800 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          Cancelled. The trucks are released{state.emailed ? ' and the client has been emailed' : ''}. It stays on Reservations under Expired, where it can be reinstated.
        </p>
        {state.warning && <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{state.warning}</p>}
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <label className="block text-xs text-gray-600">
        Reason (optional{clientEmailed ? '; with one, the client is emailed it' : clientPortal ? '; the client sees it in their portal' : ''})
        <textarea value={reason} onChange={e => setReason(e.target.value)} maxLength={CANCEL_REASON_MAX} rows={3}
          className="mt-1 block w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-400" />
      </label>
      <button type="button" onClick={cancel} disabled={state.kind === 'saving'}
        className="w-full px-4 py-2.5 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
        {state.kind === 'saving' ? 'Cancelling…' : 'Cancel this reservation'}
      </button>
      {state.kind === 'error' && <p className="text-sm text-red-700">{state.message}</p>}
    </div>
  )
}

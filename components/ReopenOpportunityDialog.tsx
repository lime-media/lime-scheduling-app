'use client'

/**
 * Asks before a Closed Lost opportunity is moved back to WARM in Salesforce
 * (Reservations → Reinstate, and Revise in the planner). The server answers
 * 409 `reopenable` with the question; `ask(question)` shows it and resolves
 * true only on "Move to Warm and continue".
 */

import { useCallback, useState, type ReactNode } from 'react'

export type Reopenable = { opportunityId: string; stageName: string; question: string }

export function useReopenConfirm(): { dialog: ReactNode; ask: (question: string) => Promise<boolean> } {
  const [pending, setPending] = useState<{ question: string; resolve: (yes: boolean) => void } | null>(null)
  const ask = useCallback((question: string) => new Promise<boolean>(resolve => setPending({ question, resolve })), [])
  const answer = (yes: boolean) => { pending?.resolve(yes); setPending(null) }
  const dialog = pending ? (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" role="alertdialog" aria-modal="true" aria-labelledby="reopen-title">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
        <div className="px-6 py-4">
          <h2 id="reopen-title" className="text-lg font-bold text-gray-900">Reopen the opportunity?</h2>
          <p className="text-sm text-gray-700 mt-2">{pending.question}</p>
          <p className="text-xs text-gray-500 mt-2">Only the stage changes in Salesforce. If Salesforce refuses, nothing changes here.</p>
        </div>
        <div className="px-6 py-3 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={() => answer(false)} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50">Cancel</button>
          <button onClick={() => answer(true)} autoFocus className="px-4 py-2 rounded-lg text-sm font-medium bg-green-600 hover:bg-green-700 text-white">Move to Warm and continue</button>
        </div>
      </div>
    </div>
  ) : null
  return { dialog, ask }
}

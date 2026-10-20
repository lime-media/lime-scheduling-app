'use client'

/**
 * Where a quote goes in Salesforce: a new opportunity (the default), or one of
 * the account's open LED opportunities, which it is added to — for a deal that
 * evolves (a quote-only log turning into a booking, markets added later)
 * without a trail of lost opportunities. Shared by both quote tools.
 */

import { useEffect, useState } from 'react'

export type OpenOpportunity = { id: string; name: string; stage: string; amount: number | null; holdStart: string | null; holdStop: string | null; hasProducts?: boolean }

const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')

export function OpportunityPicker({ accountId, value, onChange }: {
  accountId: string
  /** The opportunity to add to, or null for a new one. */
  value: OpenOpportunity | null
  onChange: (o: OpenOpportunity | null) => void
}) {
  const [opps, setOpps] = useState<OpenOpportunity[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setOpps(null); setError(null)
    fetch(`/api/sfdc/opportunities?accountId=${encodeURIComponent(accountId)}`)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Could not load opportunities'); return d.opportunities ?? [] })
      .then(list => { if (alive) setOpps(list) })
      .catch(e => { if (alive) { setError(e instanceof Error ? e.message : 'Could not load opportunities'); setOpps([]) } })
    return () => { alive = false }
  }, [accountId])

  return (
    <div>
      <label htmlFor="opp-pick" className="text-xs font-medium text-gray-600 mb-1 block">Salesforce opportunity</label>
      <select id="opp-pick" value={value?.id ?? ''} disabled={opps === null}
        onChange={e => onChange(opps?.find(o => o.id === e.target.value) ?? null)}
        className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50">
        <option value="">New opportunity</option>
        {(opps ?? []).map(o => (
          <option key={o.id} value={o.id}>
            Add to: {o.name} · {o.stage}{o.amount != null ? ` · ${money(o.amount)}` : ''}{o.hasProducts ? ' · amount set by its Salesforce quote' : ''}
          </option>
        ))}
      </select>
      <p className="mt-1 text-xs text-gray-500">
        {opps === null ? 'Loading the account’s open LED opportunities…'
          : error ? error
          : value?.hasProducts ? 'This quote’s markets and trucks are added to that opportunity. Its amount comes from its Salesforce quote, so update that quote for the new total.'
          : value ? 'This quote’s markets, trucks and amount are added to that opportunity. To change or drop markets already on it, use Revise on the Reservations page.'
          : opps.length ? `${opps.length} open LED opportunit${opps.length === 1 ? 'y' : 'ies'} on this account. Pick one to add to it instead of starting a new one.`
          : 'No open LED opportunities on this account; a new one is created.'}
      </p>
    </div>
  )
}

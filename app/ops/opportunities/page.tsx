'use client'

/**
 * Where LED opportunities are made: in the app, or directly in Salesforce
 * (/api/ops/opportunity-origins, lib/opportunityOrigins.ts). Every booking
 * should go through the app; the direct ones are the number to watch. Any
 * signed-in staff user.
 */

import { useEffect, useState } from 'react'
import { Navbar } from '@/components/Navbar'

type Opp = { id: string; createdAt: string; createdBy: string; owner: string; stage: string; week: string }
type Data = {
  from: string; to: string; truncated: boolean; markerReadable: boolean
  total: number; inApp: number; matched: number; direct: number; directPct: number
  weeks: { week: string; inApp: number; direct: number }[]
  byCreator: { createdBy: string; direct: number }[]
  direct_opportunities: Opp[]
}

const iso = (d: Date) => d.toISOString().slice(0, 10)
const day = (s: string) => new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const when = (s: string) => new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs uppercase tracking-wider text-gray-500">{label}</div>
      <div className="text-2xl font-semibold text-gray-900 tabular-nums mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  )
}

export default function OpportunityOriginsPage() {
  const [from, setFrom] = useState(iso(new Date(Date.now() - (8 * 7 - 1) * 86_400_000)))
  const [to, setTo] = useState(iso(new Date()))
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Each date change refetches; a slower, older response never overwrites a newer range.
  useEffect(() => {
    let stale = false
    setLoading(true); setError(null)
    ;(async () => {
      try {
        const res = await fetch(`/api/ops/opportunity-origins?${new URLSearchParams({ from, to })}`)
        const body = await res.json()
        if (stale) return
        if (!res.ok) throw new Error(body.error || 'Opportunity origins could not be loaded.')
        setData(body)
      } catch (e) {
        if (!stale) setError(e instanceof Error ? e.message : 'Opportunity origins could not be loaded.')
      } finally {
        if (!stale) setLoading(false)
      }
    })()
    return () => { stale = true }
  }, [from, to])

  const input = 'border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500'
  const peak = Math.max(1, ...(data?.weeks ?? []).map(w => w.inApp + w.direct))
  return (
    <>
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex flex-wrap items-end gap-3 mb-1">
          <h1 className="text-xl font-bold text-gray-900 mr-auto">Opportunity origins</h1>
          <label className="text-xs text-gray-600">Created from<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} className={`${input} block mt-1`} /></label>
          <label className="text-xs text-gray-600">To<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} className={`${input} block mt-1`} /></label>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          LED opportunities created in Salesforce, by whole Central weeks (Monday to Sunday). <strong>Made in the app</strong>: the app recorded making it
          {data?.markerReadable ? ', or it is marked Created In App in Salesforce' : ''}, or (before the app kept a record) an app reservation on it was made within 5 minutes of it.
          Everything else was made directly in Salesforce. The app creates opportunities as its integration user, so Salesforce&apos;s Created By can&apos;t tell them apart on its own.
        </p>

        {error && <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">{error}</div>}
        {loading && !data && <div className="text-sm text-gray-500">Loading…</div>}
        {data?.truncated && <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">More opportunities than can be read at once: narrow the dates for a complete count.</div>}

        {data && (
          <div className={`space-y-6 ${loading ? 'opacity-60' : ''}`}>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Tile label="LED opportunities" value={String(data.total)} sub={`${day(data.from)} – ${day(data.to)}`} />
              <Tile label="Made in the app" value={String(data.inApp)} sub={data.matched ? `${data.matched} matched by reservation time` : undefined} />
              <Tile label="Made directly in Salesforce" value={String(data.direct)} />
              <Tile label="Outside the app" value={`${data.directPct}%`} />
            </div>

            <section className="bg-white border border-gray-200 rounded-xl p-4">
              <h2 className="text-sm font-semibold text-gray-900 mb-3">By week</h2>
              <div className="space-y-1.5">
                {data.weeks.map(w => (
                  <div key={w.week} className="flex items-center gap-3 text-xs">
                    <span className="w-20 shrink-0 text-gray-600">{day(w.week)}</span>
                    <div className="flex-1 flex h-4 rounded overflow-hidden bg-gray-50" title={`${w.inApp} in the app, ${w.direct} directly in Salesforce`}>
                      <div className="bg-green-500" style={{ width: `${(w.inApp / peak) * 100}%` }} />
                      <div className="bg-amber-500" style={{ width: `${(w.direct / peak) * 100}%` }} />
                    </div>
                    <span className="w-36 shrink-0 text-right tabular-nums text-gray-700">
                      {w.inApp} app · <span className={w.direct ? 'text-amber-700 font-medium' : ''}>{w.direct} direct</span>
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex gap-4 mt-3 text-xs text-gray-500">
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-green-500" />Made in the app</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-amber-500" />Made directly in Salesforce</span>
              </div>
            </section>

            <div className="grid lg:grid-cols-3 gap-3">
              <section className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
                <h3 className="text-sm font-semibold text-gray-900 px-4 pt-3">Made directly, by who made them</h3>
                <table className="w-full text-sm mt-2">
                  <thead className="bg-gray-50 border-y border-gray-200 text-left text-xs uppercase tracking-wider text-gray-500">
                    <tr><th className="px-3 py-2">Created by</th><th className="px-3 py-2 text-right">Opportunities</th></tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data.byCreator.length === 0 && <tr><td colSpan={2} className="px-3 py-4 text-center text-gray-500">None in this range.</td></tr>}
                    {data.byCreator.map(c => (
                      <tr key={c.createdBy}><td className="px-3 py-1.5 text-gray-800">{c.createdBy}</td><td className="px-3 py-1.5 text-right tabular-nums">{c.direct}</td></tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section className="lg:col-span-2 bg-white border border-gray-200 rounded-xl overflow-x-auto">
                <h3 className="text-sm font-semibold text-gray-900 px-4 pt-3">Made directly in Salesforce</h3>
                <table className="w-full text-sm mt-2">
                  <thead className="bg-gray-50 border-y border-gray-200 text-left text-xs uppercase tracking-wider text-gray-500">
                    <tr><th className="px-3 py-2">Created</th><th className="px-3 py-2">Created by</th><th className="px-3 py-2">Owner</th><th className="px-3 py-2">Stage</th><th className="px-3 py-2">Opportunity</th></tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data.direct_opportunities.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-500">None in this range.</td></tr>}
                    {data.direct_opportunities.map(o => (
                      <tr key={o.id}>
                        <td className="px-3 py-1.5 text-gray-700 whitespace-nowrap">{when(o.createdAt)}</td>
                        <td className="px-3 py-1.5 text-gray-800">{o.createdBy}</td>
                        <td className="px-3 py-1.5 text-gray-700">{o.owner}</td>
                        <td className="px-3 py-1.5 text-gray-700">{o.stage}</td>
                        <td className="px-3 py-1.5 font-mono text-xs text-gray-500">{o.id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </div>
          </div>
        )}
      </main>
    </>
  )
}

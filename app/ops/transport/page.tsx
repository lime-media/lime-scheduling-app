'use client'

/**
 * Transport metrics — what transport bookings quote (local, absorbed, billed;
 * what we charge vs what it costs us), how it changes as bookings are edited,
 * what actually ran each campaign, and how the app's quotes compare with
 * Salesforce's Amount once a deal is won (/api/ops/transport,
 * lib/transportMetrics.ts). Any signed-in staff user.
 */

import { useEffect, useState } from 'react'
import { Navbar } from '@/components/Navbar'

type Split = { name?: string; trucks: number; local: number; absorbed: number; billed: number; charged: number; cost: number; absorbedCost: number }
type Data = {
  from: string; to: string; truncated: boolean
  transport: Split & { localPct: number; absorbedPct: number; billedPct: number; byClient: Split[]; byMarket: Split[] }
  plannedVsActual: { compared: number; avgQuotedMiles: number; avgActualMiles: number; truckChangedPct: number; outcomeChangedPct: number; unpricedRepositioning: number; unpricedCost: number }
  churn: { bookings: number; changedPct: number; swaps: number; revisions: number; changesPerBooking: number }
  deals: {
    wonDeals: number; quoted: number; contract: number; drift: number; driftPct: number
    biggest: { opportunityId: string; client: string; quoted: number; wonAmount: number; currentAmount: number; drift: number; driftPct: number }[]
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10)
const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const signed = (n: number) => `${n > 0 ? '+' : ''}${money(n)}`

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs uppercase tracking-wider text-gray-500">{label}</div>
      <div className="text-2xl font-semibold text-gray-900 tabular-nums mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  )
}

function SplitTable({ title, rows }: { title: string; rows: Split[] }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
      <h3 className="text-sm font-semibold text-gray-900 px-4 pt-3">{title}</h3>
      <table className="w-full text-sm mt-2">
        <thead className="bg-gray-50 border-y border-gray-200 text-left text-xs uppercase tracking-wider text-gray-500">
          <tr><th className="px-3 py-2">Name</th><th className="px-3 py-2 text-right">Trucks</th><th className="px-3 py-2 text-right">Local</th><th className="px-3 py-2 text-right">Absorbed</th><th className="px-3 py-2 text-right">Billed</th><th className="px-3 py-2 text-right">Charged</th><th className="px-3 py-2 text-right">Our cost</th></tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.length === 0 && <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-500">Nothing in this range.</td></tr>}
          {rows.map(r => (
            <tr key={r.name}>
              <td className="px-3 py-1.5 text-gray-800 truncate max-w-[16rem]">{r.name}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.trucks}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.local}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.absorbed}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.billed}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{money(r.charged)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{money(r.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function TransportMetricsPage() {
  const [from, setFrom] = useState(iso(new Date(Date.now() - 30 * 86_400_000)))
  const [to, setTo] = useState(iso(new Date()))
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Each date change refetches; a slower, older response never overwrites a
  // newer range, and nothing is set after unmount.
  useEffect(() => {
    let stale = false
    setLoading(true); setError(null)
    ;(async () => {
      try {
        const res = await fetch(`/api/ops/transport?${new URLSearchParams({ from, to })}`)
        const body = await res.json()
        if (stale) return
        if (!res.ok) throw new Error(body.error || 'Transport metrics could not be loaded.')
        setData(body)
      } catch (e) {
        if (!stale) setError(e instanceof Error ? e.message : 'Transport metrics could not be loaded.')
      } finally {
        if (!stale) setLoading(false)
      }
    })()
    return () => { stale = true }
  }, [from, to])

  const input = 'border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500'
  const t = data?.transport, p = data?.plannedVsActual, c = data?.churn, d = data?.deals
  return (
    <>
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex flex-wrap items-end gap-3 mb-1">
          <h1 className="text-xl font-bold text-gray-900 mr-auto">Transport metrics</h1>
          <label className="text-xs text-gray-600">Booked from<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} className={`${input} block mt-1`} /></label>
          <label className="text-xs text-gray-600">To<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} className={`${input} block mt-1`} /></label>
        </div>
        <p className="text-xs text-gray-500 mb-4">Bookings made in the range. &quot;Our cost&quot; is the estimated cost of moving trucks from outside the service area, billed or not; absorbed transport is what we pay ourselves.</p>

        {error && <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">{error}</div>}
        {loading && !data && <div className="text-sm text-gray-500">Loading…</div>}

        {t && p && c && d && (
          <div className={`space-y-6 ${loading ? 'opacity-60' : ''}`}>
            <section>
              <h2 className="text-sm font-semibold text-gray-900 mb-2">Quoted transport</h2>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-3">
                <Tile label="Trucks booked" value={String(t.trucks)} />
                <Tile label="Local / absorbed / billed" value={`${t.localPct}% / ${t.absorbedPct}% / ${t.billedPct}%`} sub={`${t.local} / ${t.absorbed} / ${t.billed} trucks`} />
                <Tile label="Transport charged" value={money(t.charged)} />
                <Tile label="Our estimated cost" value={money(t.cost)} sub={`Absorbed: ${money(t.absorbedCost)}`} />
                <Tile label="Charged − cost" value={signed(t.charged - t.cost)} />
              </div>
              <div className="grid lg:grid-cols-2 gap-3">
                <SplitTable title="By client (top 10 by cost)" rows={t.byClient} />
                <SplitTable title="By market (top 10 by cost)" rows={t.byMarket} />
              </div>
            </section>

            <section>
              <h2 className="text-sm font-semibold text-gray-900 mb-2">Planned vs actual <span className="font-normal text-gray-500">({p.compared} trucks that have started)</span></h2>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <Tile label="Avg miles quoted → actual" value={`${p.avgQuotedMiles} → ${p.avgActualMiles}`} />
                <Tile label="Different truck ran it" value={`${p.truckChangedPct}%`} />
                <Tile label="Transport outcome changed" value={`${p.outcomeChangedPct}%`} />
                <Tile label="Unpriced repositioning" value={String(p.unpricedRepositioning)} sub="Quoted local, ran from outside the area" />
                <Tile label="Unpriced cost" value={money(p.unpricedCost)} />
              </div>
            </section>

            <section>
              <h2 className="text-sm font-semibold text-gray-900 mb-2">Changes after booking</h2>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Tile label="Bookings changed" value={`${c.changedPct}%`} sub={`of ${c.bookings} bookings`} />
                <Tile label="Truck swaps" value={String(c.swaps)} />
                <Tile label="Revisions" value={String(c.revisions)} />
                <Tile label="Changes per booking" value={String(c.changesPerBooking)} />
              </div>
            </section>

            <section>
              <h2 className="text-sm font-semibold text-gray-900 mb-2">Quote vs Salesforce contract <span className="font-normal text-gray-500">({d.wonDeals} won deals)</span></h2>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
                <Tile label="App quoted" value={money(d.quoted)} />
                <Tile label="Salesforce Amount" value={money(d.contract)} sub="At Closed Won, or its latest change" />
                <Tile label="Drift" value={signed(d.drift)} sub={`${d.driftPct > 0 ? '+' : ''}${d.driftPct}%`} />
              </div>
              <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200 text-left text-xs uppercase tracking-wider text-gray-500">
                    <tr><th className="px-3 py-2">Client</th><th className="px-3 py-2">Opportunity</th><th className="px-3 py-2 text-right">App quoted</th><th className="px-3 py-2 text-right">Amount at won</th><th className="px-3 py-2 text-right">Amount now</th><th className="px-3 py-2 text-right">Drift</th></tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {d.biggest.length === 0 && <tr><td colSpan={6} className="px-3 py-4 text-center text-gray-500">No won deals with an app booking in this range yet.</td></tr>}
                    {d.biggest.map(x => (
                      <tr key={x.opportunityId}>
                        <td className="px-3 py-1.5 text-gray-800">{x.client}</td>
                        <td className="px-3 py-1.5 text-gray-500 font-mono text-xs">{x.opportunityId}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{money(x.quoted)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{money(x.wonAmount)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{money(x.currentAmount)}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${x.drift < 0 ? 'text-red-700' : 'text-gray-900'}`}>{signed(x.drift)} ({x.driftPct > 0 ? '+' : ''}{x.driftPct}%)</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            {data?.truncated && <p className="text-xs text-amber-700">Showing the first 20,000 rows; narrow the date range for complete figures.</p>}
          </div>
        )}
      </main>
    </>
  )
}

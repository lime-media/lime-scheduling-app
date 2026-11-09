'use client'

/**
 * The live bookings that won't convert cleanly into an LED program
 * (/api/ops/led-requests, lib/campaignRequests.ts). Blocked ones can't convert
 * until the issue is fixed; the rest convert with something assumed that ops
 * should check in LED afterwards. Any signed-in staff user.
 */

import { useEffect, useState } from 'react'
import { Navbar } from '@/components/Navbar'

type Issue = { kind: string; blocking: boolean; message: string; markets?: string[]; trucks?: string[] }
type Booking = { key: string; client: string; won: boolean; start: string; end: string; markets: { name: string; trucks: string[] }[]; issues: Issue[] }
type Data = { total: number; blocked: number; bookings: Booking[] }

const day = (s: string) => new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

export default function LedRequestsPage() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch('/api/ops/led-requests')
        // A gateway timeout or crash page isn't JSON: show our message, not a parse error.
        const body = await res.json().catch(() => null)
        if (!res.ok || !body) throw new Error(body?.error || 'Bookings could not be loaded.')
        setData(body)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Bookings could not be loaded.')
      }
    })()
  }, [])

  return (
    <>
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 py-6">
        <h1 className="text-xl font-bold text-gray-900 mb-1">LED readiness</h1>
        <p className="text-xs text-gray-500 mb-4">
          Live bookings that won&apos;t convert cleanly into an LED program when they&apos;re won. <strong>Blocked</strong>: LED would refuse the convert until it&apos;s fixed.
          <strong> Check</strong>: it converts, but something was assumed that ops should check in LED afterwards.
          {data && ` ${data.bookings.length} of ${data.total} live bookings listed; ${data.blocked} blocked.`}
        </p>

        {error && <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">{error}</div>}
        {!data && !error && <div className="text-sm text-gray-500">Loading…</div>}

        {data && (
          <section className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200 text-left text-xs uppercase tracking-wider text-gray-500">
                <tr><th className="px-3 py-2">Booking</th><th className="px-3 py-2">Dates</th><th className="px-3 py-2">Markets and trucks</th><th className="px-3 py-2">What&apos;s needed</th></tr>
              </thead>
              <tbody className="divide-y divide-gray-100 align-top">
                {data.bookings.length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-center text-gray-500">Every live booking is ready.</td></tr>}
                {data.bookings.map(b => (
                  <tr key={b.key}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900">{b.client}</div>
                      {b.won && <span className="text-xs text-green-700">Closed Won</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-700">{day(b.start)} – {day(b.end)}</td>
                    <td className="px-3 py-2 text-gray-700">
                      {b.markets.map(m => <div key={m.name}>{m.name} <span className="text-gray-500">· {m.trucks.join(', ')}</span></div>)}
                    </td>
                    <td className="px-3 py-2 space-y-1">
                      {b.issues.map(i => (
                        <div key={i.kind} className={i.blocking ? 'text-red-800' : 'text-amber-800'}>
                          <span className={`inline-block text-[11px] font-semibold uppercase mr-1.5 px-1.5 rounded ${i.blocking ? 'bg-red-100' : 'bg-amber-100'}`}>{i.blocking ? 'Blocked' : 'Check'}</span>
                          {i.message}
                          {i.markets && i.kind !== 'market_label' && <span className="text-gray-500"> ({i.markets.join('; ')})</span>}
                          {i.trucks && <span className="text-gray-500"> Trucks {i.trucks.join(', ')}.</span>}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </main>
    </>
  )
}

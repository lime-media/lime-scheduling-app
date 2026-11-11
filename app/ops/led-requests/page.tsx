'use client'

/**
 * The live bookings as LED campaign requests (/api/ops/led-requests,
 * lib/campaignRequests.ts). Blocked ones can't go to LED until the issue is
 * fixed; Check ones go with something assumed that ops should check in LED
 * afterwards; Ready ones go as they are. "Send to LED" sends one booking
 * (/api/ops/led-requests/send). Any signed-in staff user.
 */

import { useCallback, useEffect, useState } from 'react'
import { Navbar } from '@/components/Navbar'

type Issue = { kind: string; blocking: boolean; message: string; markets?: string[]; trucks?: string[] }
type Booking = {
  key: string; client: string; won: boolean; start: string; end: string
  markets: { name: string; trucks: string[] }[]; issues: Issue[]
  ready: boolean; sent: { coreUid: string; requestId: string | null } | null; lastError: string | null
}
type Data = { total: number; blocked: number; bookings: Booking[]; send: { enabled: boolean; reason?: string } }

const day = (s: string) => new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

export default function LedRequestsPage() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState<string | null>(null)
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ops/led-requests')
      // A gateway timeout or crash page isn't JSON: show our message, not a parse error.
      const body = await res.json().catch(() => null)
      if (!res.ok || !body) throw new Error(body?.error || 'Bookings could not be loaded.')
      setData(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bookings could not be loaded.')
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function send(key: string) {
    setSending(key)
    setSendErrors(prev => { const next = { ...prev }; delete next[key]; return next })
    try {
      const res = await fetch('/api/ops/led-requests/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingKey: key }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.sent) throw new Error(body?.error || 'Sending to LED failed.')
      // Sent, but the app couldn't record it: the button stays, with why.
      if (body.note) setSendErrors(prev => ({ ...prev, [key]: body.note }))
      await load()
    } catch (e) {
      setSendErrors(prev => ({ ...prev, [key]: e instanceof Error ? e.message : 'Sending to LED failed.' }))
    } finally {
      setSending(null)
    }
  }

  return (
    <>
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 py-6">
        <h1 className="text-xl font-bold text-gray-900 mb-1">LED readiness</h1>
        <p className="text-xs text-gray-500 mb-4">
          Live bookings as LED campaign requests. <strong>Blocked</strong>: LED would refuse it until it&apos;s fixed.
          <strong> Check</strong>: it goes to LED, but something was assumed that ops should check in LED afterwards.
          <strong> Ready</strong>: nothing to fix.
          {data && ` ${data.total} live bookings; ${data.blocked} blocked.`}
        </p>

        {data && !data.send.enabled && (
          <div className="mb-4 bg-gray-50 border border-gray-200 rounded-lg px-4 py-2 text-xs text-gray-600">{data.send.reason}</div>
        )}
        {error && <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">{error}</div>}
        {!data && !error && <div className="text-sm text-gray-500">Loading…</div>}

        {data && (
          <section className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200 text-left text-xs uppercase tracking-wider text-gray-500">
                <tr><th className="px-3 py-2">Booking</th><th className="px-3 py-2">Dates</th><th className="px-3 py-2">Markets and trucks</th><th className="px-3 py-2">What&apos;s needed</th><th className="px-3 py-2">LED</th></tr>
              </thead>
              <tbody className="divide-y divide-gray-100 align-top">
                {data.bookings.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-500">No live bookings.</td></tr>}
                {data.bookings.map(b => {
                  const failed = sendErrors[b.key] ?? b.lastError
                  return (
                    <tr key={b.key}>
                      <td className="px-3 py-2">
                        <div className="font-medium text-gray-900">{b.client}</div>
                        {b.won && <span className="text-xs text-green-700">Closed Won</span>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-700">{day(b.start)} – {day(b.end)}</td>
                      <td className="px-3 py-2 text-gray-700">
                        {b.markets.map((m, i) => <div key={i}>{m.name} <span className="text-gray-500">· {m.trucks.join(', ')}</span></div>)}
                      </td>
                      <td className="px-3 py-2 space-y-1">
                        {b.issues.length === 0 && <span className="inline-block text-[11px] font-semibold uppercase px-1.5 rounded bg-green-100 text-green-800">Ready</span>}
                        {b.issues.map(i => (
                          <div key={i.kind} className={i.blocking ? 'text-red-800' : 'text-amber-800'}>
                            <span className={`inline-block text-[11px] font-semibold uppercase mr-1.5 px-1.5 rounded ${i.blocking ? 'bg-red-100' : 'bg-amber-100'}`}>{i.blocking ? 'Blocked' : 'Check'}</span>
                            {i.message}
                            {i.markets && i.kind !== 'market_label' && <span className="text-gray-500"> ({i.markets.join('; ')})</span>}
                            {i.trucks && <span className="text-gray-500"> Trucks {i.trucks.join(', ')}.</span>}
                          </div>
                        ))}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {b.sent ? (
                          <div className="text-green-800 text-xs">
                            <div className="font-semibold">Sent</div>
                            <div className="text-gray-600">{b.sent.requestId ?? b.sent.coreUid}</div>
                          </div>
                        ) : b.ready ? (
                          <div className="max-w-xs whitespace-normal">
                            <button
                              type="button"
                              onClick={() => send(b.key)}
                              disabled={!data.send.enabled || sending !== null}
                              title={data.send.enabled ? undefined : data.send.reason}
                              className="px-2.5 py-1 text-xs font-medium rounded-md bg-green-700 text-white hover:bg-green-800 disabled:bg-gray-300 disabled:text-gray-600"
                            >
                              {sending === b.key ? 'Sending…' : 'Send to LED'}
                            </button>
                            {failed && <div className="mt-1 text-xs text-red-800">{failed}</div>}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">Fix first</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        )}
      </main>
    </>
  )
}

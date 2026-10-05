'use client'

/**
 * Usage — when the quoting tools and the AI are run, by whom, with what, and
 * how it went. App runs (lib/usageLog.ts) and MCP tool calls (mcp_query_log)
 * together, plus the MCP tokens and when each was last used. Operations only.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import { Navbar } from '@/components/Navbar'
import { MCP_TOOL_LABELS, TOOL_LABELS, describeInputs, describeResult } from '@/lib/usageFormat'

type Row = {
  id: string; at: string; source: 'app' | 'mcp'; tool: string; toolLabel: string
  actorType: string; actorId: string; actorName: string
  outcome: string; latencyMs: number; inputs: Record<string, unknown> | null; result: Record<string, unknown> | null
}
type Token = { id: string; label: string; owner: string; user_type: string; created_at: string; revoked_at: string | null; last_used_at: string | null }
type Data = { rows: Row[]; byTool: { key: string; count: number }[]; byPerson: { key: string; count: number }[]; people: { id: string; name: string }[]; tokens: Token[]; truncated: boolean }

const iso = (d: Date) => d.toISOString().slice(0, 10)
const when = (s: string | null) => (s ? new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never')
const OUTCOME: Record<string, { label: string; cls: string }> = {
  success: { label: 'OK', cls: 'bg-green-100 text-green-800' },
  not_feasible: { label: 'Not feasible', cls: 'bg-amber-100 text-amber-800' },
  no_availability: { label: 'No availability', cls: 'bg-amber-100 text-amber-800' },
  refused: { label: 'Refused', cls: 'bg-gray-100 text-gray-700' },
  error: { label: 'Error', cls: 'bg-red-100 text-red-800' },
}

export default function UsagePage() {
  const { data: session, status } = useSession()
  const [from, setFrom] = useState(iso(new Date(Date.now() - 6 * 86_400_000)))
  const [to, setTo] = useState(iso(new Date()))
  const [tool, setTool] = useState('')
  const [actor, setActor] = useState('')
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const q = new URLSearchParams({ from, to, ...(tool ? { tool } : {}), ...(actor ? { actor } : {}) })
      const res = await fetch(`/api/usage?${q}`)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Usage could not be loaded.')
      setData(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Usage could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [from, to, tool, actor])
  useEffect(() => { if (session?.user?.role === 'OPERATIONS') load() }, [load, session])

  const toolOptions = useMemo(() => [
    ...Object.entries(TOOL_LABELS).map(([v, l]) => ({ v, l })),
    { v: 'mcp', l: 'MCP: all tools' },
    ...Object.entries(MCP_TOOL_LABELS).map(([k, l]) => ({ v: `mcp:${k}`, l })),
  ], [])

  if (status === 'loading') return null
  if (session?.user?.role !== 'OPERATIONS') {
    return (<><Navbar /><div className="max-w-3xl mx-auto p-8 text-sm text-gray-600">Usage is for Operations users.</div></>)
  }

  const input = 'border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500'
  return (
    <>
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <h1 className="text-xl font-bold text-gray-900 mr-auto">Usage</h1>
          <label className="text-xs text-gray-600">From<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} className={`${input} block mt-1`} /></label>
          <label className="text-xs text-gray-600">To<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} className={`${input} block mt-1`} /></label>
          <label className="text-xs text-gray-600">Tool
            <select value={tool} onChange={e => setTool(e.target.value)} className={`${input} block mt-1`}>
              <option value="">All tools</option>
              {toolOptions.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-600">Person
            <select value={actor} onChange={e => setActor(e.target.value)} className={`${input} block mt-1 max-w-[14rem]`}>
              <option value="">Everyone</option>
              {data?.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>

        {error && <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">{error}</div>}
        {loading && !data && <div className="text-sm text-gray-500">Loading…</div>}

        {data && (
          <div className={loading ? 'opacity-60' : ''}>
            <div className="grid sm:grid-cols-2 gap-4 mb-4">
              {[{ title: 'By tool', list: data.byTool }, { title: 'By person', list: data.byPerson }].map(c => (
                <div key={c.title} className="bg-white border border-gray-200 rounded-xl p-4">
                  <h2 className="text-sm font-semibold text-gray-900 mb-2">{c.title} <span className="font-normal text-gray-500">({data.rows.length} runs)</span></h2>
                  {c.list.length === 0 ? <p className="text-sm text-gray-500">Nothing in this range.</p> : (
                    <ul className="text-sm space-y-1">
                      {c.list.slice(0, 10).map(x => (
                        <li key={x.key} className="flex justify-between gap-3"><span className="truncate text-gray-700">{x.key}</span><span className="tabular-nums text-gray-900 font-medium">{x.count}</span></li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>

            <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto mb-6">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200 text-left text-xs uppercase tracking-wider text-gray-500">
                  <tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Person</th><th className="px-3 py-2">Tool</th><th className="px-3 py-2">What</th><th className="px-3 py-2">Result</th><th className="px-3 py-2">Outcome</th><th className="px-3 py-2 text-right">Time</th></tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.rows.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-500">No runs in this range.</td></tr>}
                  {data.rows.map(r => (
                    <Fragment key={r.id}>
                      <tr className="hover:bg-gray-50 cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-600">{when(r.at)}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-900">{r.actorName}{r.actorType === 'client_user' && <span className="ml-1 text-[10px] text-gray-400 uppercase">client</span>}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-700">{r.toolLabel}</td>
                        <td className="px-3 py-2 text-gray-600 max-w-xs truncate" title={describeInputs(r.inputs)}>{describeInputs(r.inputs) || '—'}</td>
                        <td className="px-3 py-2 text-gray-600 max-w-xs truncate" title={describeResult(r.result)}>{describeResult(r.result) || '—'}</td>
                        <td className="px-3 py-2"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${(OUTCOME[r.outcome] ?? OUTCOME.refused).cls}`}>{(OUTCOME[r.outcome] ?? { label: r.outcome }).label}</span></td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-500">{r.latencyMs >= 1000 ? `${(r.latencyMs / 1000).toFixed(1)} s` : `${r.latencyMs} ms`}</td>
                      </tr>
                      {open === r.id && (
                        <tr className="bg-gray-50"><td colSpan={7} className="px-3 py-3">
                          <div className="grid md:grid-cols-2 gap-3 text-xs">
                            <div><div className="font-semibold text-gray-700 mb-1">Inputs</div><pre className="whitespace-pre-wrap break-words bg-white border border-gray-200 rounded p-2 max-h-64 overflow-auto">{JSON.stringify(r.inputs, null, 2)}</pre></div>
                            <div><div className="font-semibold text-gray-700 mb-1">Result</div><pre className="whitespace-pre-wrap break-words bg-white border border-gray-200 rounded p-2 max-h-64 overflow-auto">{JSON.stringify(r.result, null, 2)}</pre></div>
                          </div>
                        </td></tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              {data.truncated && <p className="px-3 py-2 text-xs text-amber-700 border-t border-gray-100">Showing the newest 1,000. Narrow the range to see the rest.</p>}
            </div>

            <h2 className="text-sm font-semibold text-gray-900 mb-2">MCP tokens</h2>
            <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200 text-left text-xs uppercase tracking-wider text-gray-500">
                  <tr><th className="px-3 py-2">Token</th><th className="px-3 py-2">Belongs to</th><th className="px-3 py-2">Created</th><th className="px-3 py-2">Last used</th><th className="px-3 py-2">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.tokens.map(t => (
                    <tr key={t.id}>
                      <td className="px-3 py-2 text-gray-900">{t.label}</td>
                      <td className="px-3 py-2 text-gray-600">{t.owner}</td>
                      <td className="px-3 py-2 text-gray-600">{when(t.created_at)}</td>
                      <td className={`px-3 py-2 ${t.last_used_at ? 'text-gray-700' : 'text-gray-400'}`}>{when(t.last_used_at)}</td>
                      <td className="px-3 py-2">{t.revoked_at ? <span className="text-xs text-red-700">Revoked</span> : <span className="text-xs text-green-700">Active</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </>
  )
}

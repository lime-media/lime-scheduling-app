'use client'

import { useState } from 'react'
import toast from 'react-hot-toast'

type LedClient = { client_uid: string; client: string }

/**
 * A won booking's LED client: which LED client (dbo.clients) its Salesforce
 * account is, picked once per account (app/api/led-clients). The app sets up
 * the deal's LED program under it.
 */
export function LedClientLink({ accountId, linked, onSaved }: {
  accountId: string
  linked: { client_uid: string; client: string | null } | null
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [accountName, setAccountName] = useState<string | null>(null)
  const [clients, setClients] = useState<LedClient[]>([])
  const [picked, setPicked] = useState('')
  const [suggested, setSuggested] = useState<string | null>(null)
  const [linkDeleted, setLinkDeleted] = useState(false)

  const start = async () => {
    setOpen(true)
    setLoading(true)
    try {
      const res = await fetch(`/api/led-clients?account=${encodeURIComponent(accountId)}`)
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? "Couldn't load LED clients"); setOpen(false); return }
      setAccountName(data.account_name)
      setClients(data.clients)
      setSuggested(data.suggestion?.client_uid ?? null)
      setLinkDeleted(!!data.link_deleted)
      setPicked(data.link?.client_uid ?? data.suggestion?.client_uid ?? '')
    } catch {
      toast.error('Network error')
      setOpen(false)
    } finally {
      setLoading(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/led-clients', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sfdc_account_id: accountId, client_uid: picked }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? "Couldn't save the link"); return }
      toast.success(`Linked to ${data.link.client} in LED`)
      setOpen(false)
      onSaved()
    } catch {
      toast.error('Network error')
    } finally {
      setSaving(false)
    }
  }

  // Two LED clients can share a name; the id's start tells them apart.
  const named = new Map<string, number>()
  for (const c of clients) named.set(c.client.toLowerCase(), (named.get(c.client.toLowerCase()) ?? 0) + 1)
  const label = (c: LedClient) => (named.get(c.client.toLowerCase())! > 1 ? `${c.client} (${c.client_uid.slice(0, 8)})` : c.client)

  return (
    <>
      {linked ? (
        <button type="button" onClick={start} className="text-xs text-gray-600 hover:underline" title="The LED client this account's programs belong to. Click to change.">
          LED client: {linked.client ?? 'linked'}
        </button>
      ) : (
        <button type="button" onClick={start} className="text-xs text-amber-700 font-medium hover:underline" title="Pick which LED client this Salesforce account is, once, so the app can set up its LED programs">
          Link LED client
        </button>
      )}
      {open && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-lg font-bold text-gray-900">LED client</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                Which LED client is {accountName ? <span className="font-medium text-gray-700">{accountName}</span> : 'this Salesforce account'}? Set once for the account; every won deal on it uses it.
              </p>
            </div>
            <div className="px-6 py-4 space-y-2">
              {loading ? (
                <p className="text-sm text-gray-500">Loading LED clients…</p>
              ) : (
                <>
                  {linkDeleted && (
                    <p className="text-xs text-amber-700">The LED client this account was linked to has been deleted in LED. Pick its client again.</p>
                  )}
                  <select value={picked} onChange={e => setPicked(e.target.value)} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm">
                    <option value="">Choose an LED client…</option>
                    {clients.map(c => (
                      <option key={c.client_uid} value={c.client_uid}>{label(c)}{c.client_uid === suggested ? ' (suggested)' : ''}</option>
                    ))}
                  </select>
                  {suggested && picked === suggested && !linked && (
                    <p className="text-xs text-gray-500">Suggested from the names. Check it&apos;s the right client before saving.</p>
                  )}
                </>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={save} disabled={!picked || picked === linked?.client_uid || saving || loading}
                className="px-4 py-2 text-sm rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { Navbar } from '@/components/Navbar'

type Setting = {
  key: string
  label: string
  description: string
  value: string
  source: 'stored' | 'env' | 'default'
  envVar: string
  updatedAt: string | null
  updatedBy: string | null
}

const SOURCE_LABEL: Record<Setting['source'], { text: string; className: string }> = {
  stored:  { text: 'Set here',        className: 'bg-green-100 text-green-800' },
  env:     { text: 'From env var',    className: 'bg-blue-100 text-blue-800' },
  default: { text: 'Built-in default', className: 'bg-gray-100 text-gray-600' },
}

export default function SettingsPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [settings, setSettings] = useState<Setting[]>([])
  const [canEdit, setCanEdit] = useState(false)
  const [loading, setLoading] = useState(true)
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map())
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/settings')
      if (res.ok) {
        const data = await res.json()
        setSettings(data.settings ?? [])
        setCanEdit(Boolean(data.canEdit))
        setDrafts(new Map())
      } else {
        toast.error('Could not load settings')
      }
    } catch {
      toast.error('Could not load settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const save = async (key: string) => {
    const value = drafts.get(key)
    if (value === undefined) return
    setSaving(key)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      })
      const data = await res.json()
      if (res.ok) {
        setSettings(data.settings ?? [])
        setDrafts(prev => { const next = new Map(prev); next.delete(key); return next })
        toast.success('Saved — takes effect immediately')
      } else {
        toast.error(data.error || 'Could not save')
      }
    } catch {
      toast.error('Could not save')
    } finally {
      setSaving(null)
    }
  }

  if (status === 'loading' || !session) return null

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-gray-50">
      <Navbar />
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-3xl mx-auto">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
            <p className="text-sm text-gray-500 mt-1">
              Who receives each automated notification. Changes take effect immediately — no deploy.
            </p>
          </div>

          {!canEdit && (
            <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
              You can see these but not change them. Ask an Operations user to edit.
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-16">
              <div className="w-6 h-6 border-2 border-green-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="space-y-4">
              {settings.map(s => {
                const draft = drafts.get(s.key)
                const dirty = draft !== undefined && draft !== s.value
                const badge = SOURCE_LABEL[s.source]
                return (
                  <div key={s.key} className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3 mb-1">
                      <div>
                        <h2 className="text-sm font-semibold text-gray-900">{s.label}</h2>
                        <p className="text-xs text-gray-500 mt-0.5">{s.description}</p>
                      </div>
                      <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full ${badge.className}`}>
                        {badge.text}
                      </span>
                    </div>

                    <div className="flex gap-2 mt-3">
                      <input
                        type="text"
                        value={draft ?? s.value}
                        disabled={!canEdit || saving === s.key}
                        onChange={(e) => setDrafts(prev => new Map(prev).set(s.key, e.target.value))}
                        placeholder="name@lime-media.com, other@lime-media.com"
                        className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-500"
                      />
                      {canEdit && (
                        <button
                          onClick={() => save(s.key)}
                          disabled={!dirty || saving === s.key}
                          className="px-4 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          {saving === s.key ? 'Saving…' : 'Save'}
                        </button>
                      )}
                    </div>

                    <p className="text-[11px] text-gray-400 mt-2">
                      Separate several addresses with commas.
                      {s.source === 'env' && ` Currently coming from ${s.envVar} — saving here overrides it.`}
                      {s.source === 'default' && ' No value set yet — this is the built-in default.'}
                      {s.updatedAt && ` Last changed ${new Date(s.updatedAt).toLocaleString()}${s.updatedBy ? ` by ${s.updatedBy}` : ''}.`}
                    </p>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

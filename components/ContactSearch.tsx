'use client'

/**
 * Primary contact picker: the chosen Salesforce account's Contacts, for the
 * opportunity a quote or plan creates (Primary_Contact__c). Shared by the
 * single- and multi-market quotes, after AccountSearch.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export type SfdcContact = { id: string; name: string; title?: string | null; email?: string | null }

export function ContactSearch({ accountId, selected, onSelect }: {
  accountId: string
  selected: SfdcContact | null
  onSelect: (c: SfdcContact | null) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SfdcContact[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const debounceRef = useRef<NodeJS.Timeout>()

  const load = useCallback(async (q: string) => {
    setSearching(true); setError(null)
    try {
      const res = await fetch(`/api/sfdc/contacts?accountId=${encodeURIComponent(accountId)}${q ? `&q=${encodeURIComponent(q)}` : ''}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Contact search failed')
      setResults(data.contacts ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Contact search failed')
      setResults([])
    } finally {
      setSearching(false)
    }
  }, [accountId])

  // The account's contacts as soon as it is chosen (or changed).
  useEffect(() => { setQuery(''); setResults(null); load('') }, [load])

  const search = (q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => load(q.trim()), 300)
  }

  if (selected) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm font-medium text-green-800">
          {selected.name}
          {selected.title && <span className="text-green-600 font-normal"> · {selected.title}</span>}
          {selected.email && <span className="text-green-500 text-xs ml-2">{selected.email}</span>}
        </div>
        <button onClick={() => onSelect(null)} className="text-xs text-gray-500 hover:text-gray-700 transition-colors">Change</button>
      </div>
    )
  }

  const none = results !== null && results.length === 0 && !query && !searching && !error

  return (
    <div className="relative">
      <input
        type="text"
        placeholder={none ? 'No contacts on this account' : 'Search contacts by name or email…'}
        value={query}
        disabled={none}
        onChange={(e) => { setQuery(e.target.value); search(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent disabled:bg-gray-50"
      />
      {searching && <span className="absolute right-3 top-2.5 text-xs text-gray-400">Searching...</span>}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      {none && (
        <p className="mt-1 text-xs text-amber-700">
          This account has no contacts in Salesforce. Add one there, then{' '}
          <button type="button" onClick={() => load('')} className="underline font-medium">refresh</button>.
        </p>
      )}
      {open && results && results.length > 0 && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
          {results.map((c) => (
            <button
              key={c.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onSelect(c); setQuery(''); setOpen(false) }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 border-b border-gray-100 last:border-0 transition-colors"
            >
              <span className="font-medium text-gray-900">{c.name}</span>
              {c.title && <span className="text-gray-500"> · {c.title}</span>}
              {c.email && <span className="text-gray-400 text-xs ml-2">{c.email}</span>}
            </button>
          ))}
          {results.length === 50 && <p className="px-3 py-1.5 text-[11px] text-gray-400">Showing 50 — type to narrow.</p>}
        </div>
      )}
      {open && results && results.length === 0 && query && !searching && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-xs text-gray-500">
          No contact on this account matches “{query}”.
        </div>
      )}
    </div>
  )
}

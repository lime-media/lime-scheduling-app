'use client'

/** Salesforce account picker, shared by the single- and multi-market quotes. */

import { useState, useRef, useCallback } from 'react'

export type SfdcAccount = { id: string; name: string }

export function AccountSearch({ selected, onSelect }: { selected: SfdcAccount | null; onSelect: (a: SfdcAccount | null) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SfdcAccount[]>([])
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState(false)
  const debounceRef = useRef<NodeJS.Timeout>()

  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (q.length < 2) { setResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/sfdc/accounts?q=${encodeURIComponent(q)}`)
        const data = await res.json()
        setResults(data.accounts || [])
      } catch { setResults([]) }
      finally { setSearching(false) }
    }, 300)
  }, [])

  if (selected) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm font-medium text-green-800">
          {selected.name}
          <span className="text-green-500 text-xs ml-2">{selected.id}</span>
        </div>
        <button onClick={() => onSelect(null)} className="text-xs text-gray-500 hover:text-gray-700 transition-colors">Change</button>
      </div>
    )
  }

  return (
    <div className="relative">
      <input
        type="text"
        placeholder="Search Salesforce Accounts..."
        value={query}
        onChange={(e) => { setQuery(e.target.value); search(e.target.value); setOpen(true) }}
        onFocus={() => results.length > 0 && setOpen(true)}
        className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
      />
      {searching && <span className="absolute right-3 top-2.5 text-xs text-gray-400">Searching...</span>}
      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {results.map((a) => (
            <button
              key={a.id}
              onClick={() => { onSelect(a); setQuery(''); setOpen(false) }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 border-b border-gray-100 last:border-0 transition-colors"
            >
              <span className="font-medium text-gray-900">{a.name}</span>
              <span className="text-gray-400 text-xs ml-2">{a.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}


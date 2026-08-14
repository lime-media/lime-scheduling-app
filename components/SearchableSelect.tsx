'use client'

import { useState, useRef, useEffect } from 'react'

export function SearchableSelect({
  value,
  options,
  placeholder,
  onChange,
  width = 'w-40',
  getAliasText,
}: {
  value: string
  options: string[]
  placeholder: string
  onChange: (v: string) => void
  width?: string
  // Extra searchable text per option (e.g. "Texas" for the "TX" option) so users
  // can type either form and still find it.
  getAliasText?: (option: string) => string | undefined
}) {
  const [open, setOpen]   = useState(false)
  const [query, setQuery] = useState('')
  const containerRef      = useRef<HTMLDivElement>(null)
  const inputRef          = useRef<HTMLInputElement>(null)

  const filtered = query
    ? options.filter((o) => {
        const q = query.toLowerCase()
        return o.toLowerCase().includes(q) || (getAliasText?.(o) ?? '').toLowerCase().includes(q)
      })
    : options

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const select = (v: string) => {
    onChange(v)
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={containerRef} className="relative">
      <div
        className="flex items-center border border-gray-300 rounded bg-white text-sm focus-within:ring-2 focus-within:ring-green-500 cursor-text"
        onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0) }}
      >
        {open ? (
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={value || `Search…`}
            className={`px-2 py-1 outline-none bg-transparent ${width} text-gray-800 placeholder-gray-400`}
          />
        ) : (
          <span className={`px-2 py-1 ${width} truncate ${value ? 'text-gray-800' : 'text-gray-400'}`}>
            {value || placeholder}
          </span>
        )}
        {value && !open && (
          <button
            onClick={(e) => { e.stopPropagation(); onChange('') }}
            className="pr-1.5 text-gray-400 hover:text-gray-600"
          >✕</button>
        )}
        {!value && (
          <span className="pr-2 text-gray-400 pointer-events-none">▾</span>
        )}
      </div>

      {open && (
        <ul className="absolute z-50 mt-1 max-h-60 w-48 overflow-auto rounded border border-gray-200 bg-white shadow-lg text-sm">
          <li
            onMouseDown={() => select('')}
            className="px-3 py-1.5 cursor-pointer text-gray-400 hover:bg-gray-50"
          >
            {placeholder}
          </li>
          {filtered.length === 0 ? (
            <li className="px-3 py-1.5 text-gray-400">No results</li>
          ) : (
            filtered.map((o) => (
              <li
                key={o}
                onMouseDown={() => select(o)}
                className={`px-3 py-1.5 cursor-pointer hover:bg-green-50 ${o === value ? 'bg-green-50 font-medium text-green-800' : 'text-gray-800'}`}
              >
                {o}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}

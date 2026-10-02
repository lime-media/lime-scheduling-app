'use client'

/**
 * A market box that suggests as you type (GET /api/markets/suggest):
 * standard markets first, then any US city or town, or a ZIP's place. Free
 * text still works — the server resolves whatever is submitted. Arrow keys
 * move through the list, Enter picks, Escape closes.
 */

import { useEffect, useId, useRef, useState } from 'react'

type Suggestion = { name: string; kind: 'standard' | 'place' }

export function MarketInput({ value, onChange, className, placeholder = 'e.g. Dallas, TX', ariaLabel }: {
  value: string
  onChange: (v: string) => void
  className: string
  placeholder?: string
  ariaLabel?: string
}) {
  const id = useId()
  const [items, setItems] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const typed = useRef(false) // only suggest for what the person typed, not a value set from outside

  useEffect(() => {
    if (!typed.current || value.trim().length < 3) { setItems([]); return }
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      fetch(`/api/markets/suggest?q=${encodeURIComponent(value)}`, { signal: ctrl.signal })
        .then(r => (r.ok ? r.json() : { suggestions: [] }))
        .then(d => { setItems(d.suggestions ?? []); setActive(-1); setOpen(true) })
        .catch(() => { /* aborted or offline: no suggestions */ })
    }, 150)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [value])

  const pick = (s: Suggestion) => { typed.current = false; onChange(s.name); setOpen(false); setItems([]) }
  const show = open && items.length > 0

  return (
    <div className="relative">
      <input
        type="text" value={value} placeholder={placeholder} aria-label={ariaLabel} className={className} autoComplete="off"
        role="combobox" aria-expanded={show} aria-controls={`${id}-list`} aria-autocomplete="list"
        aria-activedescendant={show && active >= 0 ? `${id}-${active}` : undefined}
        onChange={e => { typed.current = true; onChange(e.target.value) }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onFocus={() => items.length && setOpen(true)}
        onKeyDown={e => {
          if (!show) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(items.length - 1, a + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)) }
          else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(items[active]) }
          else if (e.key === 'Escape') setOpen(false)
        }}
      />
      {show && (
        <ul id={`${id}-list`} role="listbox" className="absolute z-30 mt-1 w-full max-h-64 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg py-1 text-sm">
          {items.map((s, i) => (
            <li key={s.name} id={`${id}-${i}`} role="option" aria-selected={i === active}
              onMouseDown={e => { e.preventDefault(); pick(s) }}
              className={`px-3 py-1.5 cursor-pointer flex items-center justify-between gap-2 ${i === active ? 'bg-green-50 text-gray-900' : 'text-gray-700 hover:bg-gray-50'}`}>
              <span className="truncate">{s.name}</span>
              {s.kind === 'standard' && <span className="text-[10px] uppercase tracking-wide text-gray-400">Market</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

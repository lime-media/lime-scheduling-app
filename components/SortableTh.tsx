'use client'

/**
 * Click-to-sort table headers (lib/tableSort.ts). Each table remembers its
 * sort in this browser, so a sort someone works in (soft holds by truck,
 * say) is still there next visit.
 */

import { useCallback, useEffect, useState } from 'react'
import { nextSort, type SortState } from '@/lib/tableSort'

/**
 * A table's sort, remembered per `storageKey` in this browser. `null` until
 * someone clicks a header: rows keep the order the API sent.
 */
export function useTableSort<K extends string>(storageKey: string, valid: readonly K[]) {
  const [sort, setSort] = useState<SortState<K> | null>(null)

  // Read after mount (the server render has no localStorage), and again when
  // the key changes — the Reservations page keeps one sort per status filter.
  useEffect(() => {
    let saved: SortState<K> | null = null
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
      if (raw && valid.includes(raw.by) && (raw.dir === 'asc' || raw.dir === 'desc')) saved = raw
    } catch { /* private window or bad JSON: no saved sort */ }
    setSort(saved)
    // `valid` is a constant list per table; the key is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])

  const sortBy = useCallback((by: K) => {
    setSort(cur => {
      const next = nextSort(cur, by)
      try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* not saved; still sorts */ }
      return next
    })
  }, [storageKey])

  /** Set the sort outright; null goes back to the API's order. */
  const chooseSort = useCallback((next: SortState<K> | null) => {
    setSort(next)
    try {
      if (next) localStorage.setItem(storageKey, JSON.stringify(next))
      else localStorage.removeItem(storageKey)
    } catch { /* not saved; still sorts */ }
  }, [storageKey])

  return { sort, sortBy, chooseSort }
}

/**
 * The same sort as a dropdown, for lists that are not one table (the
 * Reservations campaign cards) and for small screens. `defaultLabel` names
 * the API's order, shown when no column is chosen.
 */
export function SortSelect<K extends string>({ columns, sort, onChange, defaultLabel }: {
  columns: readonly { key: K; label: string }[]
  sort: SortState<K> | null
  onChange: (next: SortState<K> | null) => void
  defaultLabel: string
}) {
  return (
    <div className="flex items-center gap-1.5 text-sm">
      <label htmlFor="list-sort" className="text-gray-500">Sort</label>
      <select id="list-sort" value={sort?.by ?? ''}
        onChange={e => onChange(e.target.value ? { by: e.target.value as K, dir: sort?.dir ?? 'asc' } : null)}
        className="border border-gray-200 rounded-lg px-2 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500">
        <option value="">{defaultLabel}</option>
        {columns.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
      </select>
      {sort && (
        <button type="button" onClick={() => onChange({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
          title={sort.dir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
          className="border border-gray-200 rounded-lg px-2.5 py-2 text-xs text-gray-600 bg-white hover:bg-gray-50">
          {sort.dir === 'asc' ? '▲ Asc' : '▼ Desc'}
        </button>
      )}
    </div>
  )
}

const TH = 'px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider'

/** A header cell that sorts its table. Pass no `sortKey` for a plain header (e.g. Actions). */
export function SortableTh<K extends string>({ label, sortKey, sort, onSort, className = TH }: {
  label: string
  sortKey?: K
  sort: SortState<K> | null
  onSort: (by: K) => void
  className?: string
}) {
  if (!sortKey) return <th scope="col" className={className}>{label}</th>
  const active = sort?.by === sortKey
  return (
    <th scope="col" className={className} aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(sortKey)} title={`Sort by ${label}`}
        className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-gray-800">
        {label}
        <span aria-hidden className={`text-[9px] ${active ? 'text-gray-700' : 'text-gray-300'}`}>
          {active && sort!.dir === 'desc' ? '▼' : '▲'}
        </span>
      </button>
    </th>
  )
}

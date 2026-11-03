'use client'

/**
 * The two Salesforce fields a seller picks on every quote that makes an
 * opportunity: Client Type and Lead Source. Each starts at the account's
 * suggestion (components/AccountSearch.tsx) and the seller confirms or
 * changes it. Client type also sets Brand Direct pricing, so changing it
 * means a fresh price.
 */
import type { ClientType } from '@/lib/pricing/brandMarkup'
import { LEAD_SOURCES } from '@/lib/sfdcLeadSource'

const CLIENT_TYPES: ClientType[] = ['Agency', 'Brand Direct']

export function ClientTypePicker({ value, onChange }: { value: ClientType; onChange: (t: ClientType) => void }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-medium text-gray-600">Client type <span className="text-red-500">*</span></span>
      <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5" role="radiogroup" aria-label="Client type">
        {CLIENT_TYPES.map(t => (
          <button key={t} type="button" role="radio" aria-checked={value === t} onClick={() => onChange(t)}
            className={`px-3 py-1 rounded-md font-medium transition-colors ${value === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
            {t}
          </button>
        ))}
      </div>
    </div>
  )
}

export function LeadSourcePicker({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="font-medium text-gray-600">Lead source <span className="text-red-500">*</span></span>
      <select value={value} onChange={e => onChange(e.target.value)} aria-label="Lead source"
        className={`border rounded-lg px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-green-500 ${value ? 'border-gray-200 text-gray-900' : 'border-amber-300 text-gray-500'}`}>
        <option value="">Choose…</option>
        {LEAD_SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
    </label>
  )
}

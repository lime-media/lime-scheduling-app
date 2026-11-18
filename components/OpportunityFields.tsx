'use client'

/**
 * The Salesforce fields a seller picks on every quote that makes an
 * opportunity: Client Type, Lead Source and Opportunity Type. Each starts at
 * the account's suggestion (components/AccountSearch.tsx) and the seller
 * confirms or changes it. Client type also sets Brand Direct pricing, so
 * changing it means a fresh price.
 */
import type { ClientType } from '@/lib/pricing/brandMarkup'
import { LEAD_SOURCES } from '@/lib/sfdcLeadSource'
import { OPPORTUNITY_TYPES } from '@/lib/sfdcOpportunityType'
import { OPPORTUNITY_NAME_MAX } from '@/lib/opportunityName'

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

/** A required Salesforce picklist as a select, amber until something is chosen. */
function PicklistSelect({ label, options, value, onChange }: { label: string; options: readonly string[]; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="font-medium text-gray-600">{label} <span className="text-red-500">*</span></span>
      <select value={value} onChange={e => onChange(e.target.value)} aria-label={label}
        className={`border rounded-lg px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-green-500 ${value ? 'border-gray-200 text-gray-900' : 'border-amber-300 text-gray-500'}`}>
        <option value="">Choose…</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  )
}

export function LeadSourcePicker({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return <PicklistSelect label="Lead source" options={LEAD_SOURCES} value={value} onChange={onChange} />
}

export function OpportunityTypePicker({ value, onChange }: { value: string; onChange: (t: string) => void }) {
  return <PicklistSelect label="Opportunity type" options={OPPORTUNITY_TYPES} value={value} onChange={onChange} />
}

/**
 * A new opportunity's name: shows the name the app would generate until the
 * seller types their own (`value` null = follow the default as the quote
 * changes). Sent blank, the server uses the default (lib/opportunityName.ts).
 */
export function OpportunityNameInput({ value, defaultName, onChange }: { value: string | null; defaultName: string; onChange: (v: string | null) => void }) {
  const edited = value !== null && value !== defaultName
  const blank = value !== null && !value.trim()
  return (
    <label className="block text-xs">
      <span className="flex items-center justify-between gap-2">
        <span className="font-medium text-gray-600">Opportunity name</span>
        {edited && (
          <button type="button" onClick={() => onChange(null)} className="text-gray-500 hover:text-gray-800 underline">
            Use the default
          </button>
        )}
      </span>
      <input type="text" value={value ?? defaultName} maxLength={OPPORTUNITY_NAME_MAX} aria-label="Opportunity name"
        onChange={e => onChange(e.target.value)}
        className="mt-1 w-full border border-gray-200 rounded-lg px-2 py-1 text-xs text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-green-500" />
      <span className="mt-0.5 block text-[11px] text-gray-400">{blank ? 'Left blank, the opportunity gets the default name.' : edited ? 'Salesforce gets this name.' : 'The name the app generates from what is booked (shown in the confirmation). Type to use your own.'}</span>
    </label>
  )
}

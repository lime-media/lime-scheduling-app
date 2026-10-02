'use client'

/**
 * The brand on a quote (lib/brand.ts): goes to Salesforce as Brand / Job
 * Name and leads the Opportunity name, so the deal is searchable by brand.
 * Shows what will be saved whenever cleaning changes what was typed.
 */

import { useId } from 'react'
import { BRAND_MAX, brandChange, cleanBrand } from '@/lib/brand'

export function BrandInput({ value, onChange, className, hint = 'Goes to the Salesforce opportunity and leads its name, so it can be searched.', label = 'Brand' }: {
  value: string
  onChange: (v: string) => void
  className: string
  /** Shown under the box when nothing was cleaned. The client portal says less. */
  hint?: string
  label?: string
}) {
  const id = useId()
  const saved = cleanBrand(value)
  const change = brandChange(value)
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor={id}>{label}</label>
      <input id={id} type="text" value={value} maxLength={BRAND_MAX + 30} placeholder="e.g. Nike (the brand on the campaign)"
        onChange={e => onChange(e.target.value)} className={className} aria-describedby={`${id}-hint`} />
      <p id={`${id}-hint`} className="mt-1 text-[11px] text-gray-500">
        {change === 'stripped'
          ? <>Saved as <span className="font-medium text-gray-700">{saved}</span>: brand only, no asset, month or year.</>
          : change === 'cut'
            ? <>Saved as <span className="font-medium text-gray-700">{saved}</span>: Salesforce keeps {BRAND_MAX} characters.</>
            : hint}
      </p>
    </div>
  )
}

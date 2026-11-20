'use client'

/**
 * A priced option switch and the lift-study names, shared by the client
 * portal's one-market quote (app/client/ai/page.tsx) and its several-markets
 * quote (components/ClientMultiMarketQuote.tsx), so both look and read alike.
 */

/** The lift studies a client can pick, in the order both forms show them. */
export const STUDY_CHOICES = ['web_lift', 'foot_traffic', 'sales_lift', 'brand_lift'] as const
export const STUDY_LABELS: Record<string, string> = {
  web_lift: 'Web Lift',
  foot_traffic: 'Foot Traffic',
  sales_lift: 'Sales Lift',
  brand_lift: 'Brand Lift',
}

const fmtMoney = (n: number) => '$' + Math.round(n).toLocaleString('en-US')

export function FeatureToggle({
  label,
  description,
  cost,
  checked,
  onChange,
  disabled = false,
}: {
  label: string
  description: string
  cost: number
  checked: boolean
  onChange: (v: boolean) => void
  /** Locked, e.g. while a booking is being sent. */
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900">{label}</p>
        <p className="text-xs text-gray-500 truncate">{description}</p>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <span className="text-xs text-gray-500 font-medium">{fmtMoney(cost)}</span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
            checked ? 'bg-green-600' : 'bg-gray-200'
          }`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`} />
        </button>
      </div>
    </div>
  )
}


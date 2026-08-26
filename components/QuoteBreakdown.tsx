'use client'

// Line-item breakdown of how a hold's quoted_total was derived — shown on both the client's
// My Requests page and the internal staff Hold Requests review page, so both sides see exactly
// what's being paid for (base media, shadow fencing, add-ons, lift studies) instead of just a
// tier name and a total. Sourced from HoldRequest.features, a JSON snapshot of the quote tier
// that was chosen, captured at hold-creation time (see app/api/client/chat/route.ts).

export type QuoteFeatures = {
  dailyRate?: number
  hourSurcharge?: number
  truckDays?: number
  baseMedia?: number
  shadowFencing?: number
  shadowFencingFloored?: boolean
  smartDirectionalIncluded?: boolean
  smartDirectional?: number
  deviceIdIncluded?: boolean
  deviceId?: number
  studies?: string[]
  studyCost?: number
  studiesTotal?: number
}

function fmtMoney(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

export function parseQuoteFeatures(features: string | null | undefined): QuoteFeatures | null {
  if (!features) return null
  try {
    return JSON.parse(features) as QuoteFeatures
  } catch {
    return null
  }
}

export function QuoteBreakdown({ features }: { features: QuoteFeatures }) {
  const lines: { label: string; amount: number }[] = []

  if (features.baseMedia) {
    const perDay = features.dailyRate ? fmtMoney(features.dailyRate) : null
    const days = features.truckDays
    const rateLabel = perDay && days
      ? ` (${perDay}/truck-day${features.hourSurcharge ? ` + ${fmtMoney(features.hourSurcharge)} extra hours` : ''} × ${days} truck-day${days === 1 ? '' : 's'})`
      : ''
    lines.push({ label: `Base media${rateLabel}`, amount: features.baseMedia })
  }
  if (features.shadowFencing) {
    lines.push({
      label: `Shadow fencing${features.shadowFencingFloored ? ' (minimum applied)' : ' (25% of base media)'}`,
      amount: features.shadowFencing,
    })
  }
  if (features.smartDirectionalIncluded && features.smartDirectional) {
    lines.push({ label: 'Smart Directional', amount: features.smartDirectional })
  }
  if (features.deviceIdIncluded && features.deviceId) {
    lines.push({ label: 'Device ID Passback', amount: features.deviceId })
  }
  if (features.studies && features.studies.length > 0 && features.studiesTotal) {
    lines.push({
      label: `Lift stud${features.studies.length === 1 ? 'y' : 'ies'} (${features.studies.map((s) => s.replace(/_/g, ' ')).join(', ')})`,
      amount: features.studiesTotal,
    })
  }

  if (lines.length === 0) return null

  const total = lines.reduce((sum, l) => sum + l.amount, 0)

  return (
    <div className="text-xs text-gray-600 space-y-1">
      {lines.map((l) => (
        <div key={l.label} className="flex justify-between gap-3">
          <span>{l.label}</span>
          <span className="font-medium text-gray-800 flex-shrink-0">{fmtMoney(l.amount)}</span>
        </div>
      ))}
      <div className="flex justify-between gap-3 pt-1 mt-1 border-t border-gray-200 font-semibold text-gray-900">
        <span>Total</span>
        <span>{fmtMoney(total)}</span>
      </div>
    </div>
  )
}

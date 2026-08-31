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
  truckCount?: number
  activationDays?: number
  calendarDays?: number
  daysPerWeek?: number
  operatingHours?: number
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
  transportCharge?: number
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

  // Schedule summary
  const scheduleLabel = features.activationDays && features.calendarDays && features.activationDays !== features.calendarDays
    ? `${features.activationDays} activation days (${features.calendarDays} calendar days, ${features.daysPerWeek === 5 ? 'Mon-Fri' : features.daysPerWeek === 6 ? 'Mon-Sat' : '7 days'})`
    : features.activationDays
      ? `${features.activationDays} day${features.activationDays === 1 ? '' : 's'}`
      : null
  const hoursLabel = features.operatingHours && features.operatingHours > 8
    ? ` · ${features.operatingHours}hr days`
    : ''

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
  if (features.transportCharge && features.transportCharge > 0) {
    lines.push({ label: 'Transport', amount: features.transportCharge })
  }

  if (lines.length === 0) return null

  const total = lines.reduce((sum, l) => sum + l.amount, 0)

  return (
    <div className="text-xs text-gray-600 space-y-1">
      {scheduleLabel && (
        <div className="text-gray-500 mb-1.5">
          {scheduleLabel}{hoursLabel}
        </div>
      )}
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

/**
 * Build a plain-text activation notes string from quote features.
 * Used for Salesforce Opportunity.Activation_Notes__c.
 */
export function buildActivationNotes(features: QuoteFeatures, tier?: string | null): string {
  const parts: string[] = []

  if (tier) parts.push(`Tier: ${tier}`)

  if (features.truckCount) parts.push(`${features.truckCount} truck${features.truckCount === 1 ? '' : 's'}`)

  if (features.activationDays && features.calendarDays && features.activationDays !== features.calendarDays) {
    const sched = features.daysPerWeek === 5 ? 'Mon-Fri' : features.daysPerWeek === 6 ? 'Mon-Sat' : '7 days/week'
    parts.push(`${features.activationDays} activation days (${features.calendarDays} calendar days, ${sched})`)
  } else if (features.activationDays) {
    parts.push(`${features.activationDays} days`)
  }

  if (features.operatingHours && features.operatingHours > 8) {
    parts.push(`${features.operatingHours}-hour days`)
  }

  if (features.dailyRate) parts.push(`Rate: $${features.dailyRate}/truck-day`)
  if (features.truckDays) parts.push(`${features.truckDays} truck-days`)

  const featureList: string[] = []
  if (features.shadowFencing) featureList.push('Shadow Fencing')
  if (features.smartDirectionalIncluded) featureList.push('Smart Directional')
  if (features.deviceIdIncluded) featureList.push('Device ID Passback')
  if (features.studies && features.studies.length > 0) {
    featureList.push(`Lift Studies (${features.studies.map(s => s.replace(/_/g, ' ')).join(', ')})`)
  }
  if (featureList.length > 0) parts.push(`Features: ${featureList.join(', ')}`)

  if (features.transportCharge && features.transportCharge > 0) {
    parts.push(`Transport: $${Math.round(features.transportCharge).toLocaleString()}`)
  }

  if (features.baseMedia) {
    const total = (features.baseMedia || 0) + (features.shadowFencing || 0) + (features.smartDirectional || 0) + (features.deviceId || 0) + (features.studiesTotal || 0) + (features.transportCharge || 0)
    parts.push(`Total: $${Math.round(total).toLocaleString()}`)
  }

  return parts.join(' | ')
}

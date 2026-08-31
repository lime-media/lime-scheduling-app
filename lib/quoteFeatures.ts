/**
 * Shared quote features parsing and formatting — used by both server-side
 * API routes (SFDC activation notes) and the client-side QuoteBreakdown component.
 */

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

export function parseQuoteFeatures(features: string | null | undefined): QuoteFeatures | null {
  if (!features) return null
  try {
    return JSON.parse(features) as QuoteFeatures
  } catch {
    return null
  }
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

/**
 * Shared quote features parsing and formatting — used by both server-side
 * API routes (SFDC activation notes) and the client-side QuoteBreakdown component.
 */

import { APP_HOLD_EXP_KEY } from '@/lib/sfdcIntegration'

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
  /**
   * The dates the client asked for in this market (YYYY-MM-DD). A hold's own
   * dates can differ: a truck shared between two markets holds its days in
   * each plus travel. Revising reads these (lib/bookings.ts reviseRows).
   */
  requestedStart?: string
  requestedEnd?: string
  /**
   * Booked onto an opportunity that already existed (a quote added to it, or
   * a revision of such a booking). Its lapsing never closes that opportunity:
   * the deal isn't the app's to lose (lib/sfdcIntegration.ts).
   */
  attachedToOpportunity?: boolean
  /** The Brand Direct markup (%) folded into these prices; 0 for other clients. A revision keeps it. */
  brandMarkupPct?: number
  /**
   * Deadhead this booking adds to each truck's next job, captured at hold time.
   * Recorded for review only — never part of any total, and deliberately absent
   * from buildActivationNotes() so it cannot reach a Salesforce buyer view.
   */
  successorImpact?: {
    truckNumber: string
    successorMarket: string
    successorStart: string
    deltaTransportDays: number
    deltaCost: number
  }[]
}

/**
 * A hold's quote breakdown, or null when its features hold no quote: a
 * Salesforce-made hold's features may carry only the app's bookkeeping (the
 * LED Hold Exp it last wrote, lib/sfdcIntegration.ts APP_HOLD_EXP_KEY), which
 * must not render as an empty breakdown.
 */
export function parseQuoteFeatures(features: string | null | undefined): QuoteFeatures | null {
  if (!features) return null
  try {
    const f = JSON.parse(features) as QuoteFeatures
    return f && typeof f === 'object' && Object.keys(f).some(k => k !== APP_HOLD_EXP_KEY) ? f : null
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

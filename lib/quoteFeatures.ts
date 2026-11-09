/**
 * Shared quote features parsing and formatting — used by both server-side
 * API routes (SFDC activation notes) and the client-side QuoteBreakdown component.
 */

/**
 * The key in a hold's features JSON recording the LED Hold Exp the app last
 * wrote to its opportunity (lib/sfdcIntegration.ts appHoldExpOf). Kept here,
 * not in the server-side Salesforce module, because this file is bundled for
 * the browser too.
 */
export const APP_HOLD_EXP_KEY = 'appHoldExp'

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
  /** The client type the seller priced it as (Agency / Brand Direct). A revision reopens as it. */
  clientType?: 'Agency' | 'Brand Direct'
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
 * Keys in `features` that are internal, never sent to a client: Brand Direct
 * pricing (markup, client type), the deadhead cost a booking adds to the next
 * job, and the app's Salesforce bookkeeping.
 */
const INTERNAL_KEYS = ['brandMarkupPct', 'clientType', 'successorImpact', APP_HOLD_EXP_KEY] as const

/**
 * A hold's `features` as a client may see them: the internal keys removed
 * (INTERNAL_KEYS). Unparseable text is passed through as it was stored. Pure.
 */
export function clientVisibleFeatures(features: string | null | undefined): string | null {
  if (!features) return null
  try {
    const f = JSON.parse(features) as Record<string, unknown>
    if (!f || typeof f !== 'object' || Array.isArray(f) || !INTERNAL_KEYS.some(k => k in f)) return features
    for (const k of INTERNAL_KEYS) delete f[k]
    return JSON.stringify(f)
  } catch {
    return features
  }
}

const isIsoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

/**
 * A hold's features after staff re-date it (PUT /api/holds/[id]): the asked-for
 * date (requestedStart/requestedEnd) on each side staff moved becomes the
 * hold's new date there; a side passed as null keeps its asked-for date (the
 * hold's own date there can include a shared truck's travel days). Left as
 * they were, an extension still containing the old dates would be revised as
 * the old, shorter ones. Features that never stored asked-for dates, or can't
 * be read, come back unchanged: readers fall back to the holds' own dates. Pure.
 */
export function withAskedDates(features: string | null, start: string | null, end: string | null): string | null {
  if (!features) return features
  try {
    const f = JSON.parse(features) as Record<string, unknown>
    if (!f || typeof f !== 'object' || Array.isArray(f) || !('requestedStart' in f || 'requestedEnd' in f)) return features
    const next = { ...f, ...(start !== null && { requestedStart: start }), ...(end !== null && { requestedEnd: end }) }
    if (next.requestedStart === f.requestedStart && next.requestedEnd === f.requestedEnd) return features
    return JSON.stringify(next)
  } catch {
    return features
  }
}

/**
 * The dates asked for across one market line's holds: the earliest start and
 * latest end any of them stores. A line's holds share their features when
 * booked; after a hold is re-dated alone (withAskedDates) they can differ, and
 * the line covers them all. Null when none stores both.
 */
export function askedDates(features: (string | null)[]): { start: string; end: string } | null {
  const starts: string[] = [], ends: string[] = []
  for (const raw of features) {
    if (!raw) continue
    try {
      const f = JSON.parse(raw) as Record<string, unknown> | null
      if (!f || typeof f !== 'object' || Array.isArray(f)) continue
      if (isIsoDate(f.requestedStart)) starts.push(f.requestedStart)
      if (isIsoDate(f.requestedEnd)) ends.push(f.requestedEnd)
    } catch { /* unreadable: not asked-for dates */ }
  }
  return starts.length && ends.length ? { start: starts.sort()[0], end: ends.sort().reverse()[0] } : null
}

/**
 * A hold's quote breakdown, or null when its features hold no quote: a
 * Salesforce-made hold's features may carry only the app's bookkeeping (the
 * LED Hold Exp it last wrote, APP_HOLD_EXP_KEY), which
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

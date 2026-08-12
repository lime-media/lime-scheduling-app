/**
 * Core pricing engine for Lime Media LED truck quotes.
 *
 * Computes Good / Better / Best tiered quotes with:
 * - Tiered rate card (duration-based, single card)
 * - Cumulative truck-day optimization
 * - Shadow fencing, add-ons, hours surcharge
 * - Lift studies (gated by physical impressions)
 * - Rate Agreement overrides
 */

import {
  RATE_CARD,
  SMART_DIRECTIONAL_PER_TRUCK_DAY,
  DEVICE_ID_PASSBACK_FLAT,
  HOUR_SURCHARGE_PER_HOUR,
  STANDARD_HOURS,
  SHADOW_FENCING_RATE,
  SHADOW_FENCING_FLOOR,
  SHADOW_FENCING_CPM,
  STUDY_PRICE,
  STUDY_MIN_IMPRESSIONS,
  VALID_STUDIES,
  MARKET_SIZE_TIERS,
  type RateOverrides,
  type StudyType,
} from './config'

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type QuoteInput = {
  truckCount: number
  days: number
  operatingHours?: number        // default 8
  marketSizeTierId?: number      // 1-4, default 3
  includeSmartDirectional?: boolean
  includeDeviceId?: boolean
  studies?: StudyType[]
  rateOverrides?: RateOverrides | null
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type QuoteResult = {
  input: {
    truckCount: number
    days: number
    truckDays: number
    operatingHours: number
    marketSizeTier: { id: number; label: string; dailyA18: number }
  }
  dailyRate: number
  hourSurcharge: number
  effectiveDailyRate: number  // dailyRate + hourSurcharge
  good: TierGood
  better: TierBetter
  best: TierBest
  pricingBasis: string  // "standard" or agreement name
}

export type TierGood = {
  baseMedia: number
  total: number
}

export type TierBetter = {
  baseMedia: number
  shadowFencing: number
  shadowFencingFloored: boolean
  digitalImpressions: number
  smartDirectional: number
  smartDirectionalIncluded: boolean
  deviceId: number
  deviceIdIncluded: boolean
  total: number
}

export type TierBest = {
  betterTotal: number
  studies: StudyType[]
  studyCost: number
  studiesTotal: number
  reachOk: boolean
  estimatedImpressions: number
  total: number
}

// ---------------------------------------------------------------------------
// Rate lookup
// ---------------------------------------------------------------------------

/**
 * Find the daily rate for a given duration.
 *
 * Uses cumulative truck-day optimization: evaluates both per-truck duration
 * AND total truck-days, and picks whichever gives the lower rate.
 */
export function getDailyRate(
  days: number,
  truckCount: number,
  overrides?: RateOverrides | null,
): number {
  const truckDays = days * truckCount

  function lookupRate(effectiveDays: number): number {
    // Check overrides first
    if (overrides?.daily_rates) {
      for (const tier of RATE_CARD) {
        if (effectiveDays >= tier.minDays && effectiveDays <= tier.maxDays) {
          const tierKey = `${tier.minDays}_${tier.maxDays === Infinity ? 999 : tier.maxDays}`
          if (tierKey in overrides.daily_rates) {
            return overrides.daily_rates[tierKey]!
          }
          return tier.rate
        }
      }
    }
    // Standard card
    for (const tier of RATE_CARD) {
      if (effectiveDays >= tier.minDays && effectiveDays <= tier.maxDays) {
        return tier.rate
      }
    }
    throw new Error(`No rate tier matches ${effectiveDays} days`)
  }

  const perTruckRate = lookupRate(days)
  const cumulativeRate = lookupRate(truckDays)

  return Math.min(perTruckRate, cumulativeRate)
}

// ---------------------------------------------------------------------------
// Quote computation
// ---------------------------------------------------------------------------

export function computeQuote(input: QuoteInput): QuoteResult {
  const {
    truckCount,
    days,
    operatingHours = STANDARD_HOURS,
    marketSizeTierId = 3,
    includeSmartDirectional = false,
    includeDeviceId = false,
    studies = [],
    rateOverrides = null,
  } = input

  if (truckCount < 1) throw new Error('truckCount must be at least 1')
  if (days < 1) throw new Error('days must be at least 1')
  if (operatingHours < STANDARD_HOURS || operatingHours > 12) {
    throw new Error(`operatingHours must be between ${STANDARD_HOURS} and 12`)
  }

  const invalidStudies = studies.filter(s => !(VALID_STUDIES as readonly string[]).includes(s))
  if (invalidStudies.length > 0) {
    throw new Error(`Invalid studies: ${invalidStudies.join(', ')}`)
  }

  const truckDays = truckCount * days
  const marketSizeTier = MARKET_SIZE_TIERS.find(t => t.id === marketSizeTierId)
  if (!marketSizeTier) throw new Error(`Invalid marketSizeTierId: ${marketSizeTierId}`)

  // Rate
  const dailyRate = getDailyRate(days, truckCount, rateOverrides)
  const hourSurchargeRate = rateOverrides?.hour_surcharge ?? HOUR_SURCHARGE_PER_HOUR
  const hourSurcharge = Math.max(0, operatingHours - STANDARD_HOURS) * hourSurchargeRate
  const effectiveDailyRate = dailyRate + hourSurcharge

  // Tier 1 — Good
  const baseMedia = truckDays * effectiveDailyRate
  const good: TierGood = {
    baseMedia,
    total: baseMedia,
  }

  // Tier 2 — Better
  const sfRate = rateOverrides?.shadow_fencing_pct ?? SHADOW_FENCING_RATE
  const sfFloor = rateOverrides?.shadow_fencing_floor ?? SHADOW_FENCING_FLOOR
  const sfRaw = baseMedia * sfRate
  const shadowFencing = Math.max(sfRaw, sfFloor)
  const shadowFencingFloored = sfRaw < sfFloor

  const digitalImpressions = (shadowFencing / SHADOW_FENCING_CPM) * 1000

  const sdDaily = rateOverrides?.smart_directional_daily ?? SMART_DIRECTIONAL_PER_TRUCK_DAY
  const smartDirectional = includeSmartDirectional ? truckDays * sdDaily : 0

  const didFlat = rateOverrides?.device_id_flat ?? DEVICE_ID_PASSBACK_FLAT
  const deviceId = includeDeviceId ? didFlat : 0

  const betterTotal = baseMedia + shadowFencing + smartDirectional + deviceId
  const better: TierBetter = {
    baseMedia,
    shadowFencing,
    shadowFencingFloored,
    digitalImpressions,
    smartDirectional,
    smartDirectionalIncluded: includeSmartDirectional,
    deviceId,
    deviceIdIncluded: includeDeviceId,
    total: betterTotal,
  }

  // Tier 3 — Best
  const estimatedImpressions = truckCount * days * marketSizeTier.dailyA18
  const reachOk = estimatedImpressions >= STUDY_MIN_IMPRESSIONS
  const studyCost = rateOverrides?.study_cost ?? STUDY_PRICE
  const studiesTotal = reachOk ? studies.length * studyCost : 0

  const best: TierBest = {
    betterTotal,
    studies: reachOk ? studies : [],
    studyCost,
    studiesTotal,
    reachOk,
    estimatedImpressions,
    total: betterTotal + studiesTotal,
  }

  // Pricing basis
  const pricingBasis = rateOverrides ? 'agreement' : 'standard'

  return {
    input: {
      truckCount,
      days,
      truckDays,
      operatingHours,
      marketSizeTier: {
        id: marketSizeTier.id,
        label: marketSizeTier.label,
        dailyA18: marketSizeTier.dailyA18,
      },
    },
    dailyRate,
    hourSurcharge,
    effectiveDailyRate,
    good,
    better,
    best,
    pricingBasis,
  }
}

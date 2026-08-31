/**
 * Canonical pricing configuration for Lime Media LED trucks.
 *
 * This is the SINGLE SOURCE OF TRUTH for all pricing constants.
 * Both the Quote Builder UI and the MCP server derive from this.
 *
 * DO NOT duplicate these values elsewhere in the codebase.
 */

// ---------------------------------------------------------------------------
// Rate card: per-truck, per-day, 8-hour operating day
// ---------------------------------------------------------------------------

export type RateTier = {
  minDays: number
  maxDays: number
  rate: number
}

export const RATE_CARD: RateTier[] = [
  { minDays: 1,  maxDays: 1,        rate: 1850 },
  { minDays: 2,  maxDays: 10,       rate: 1350 },
  { minDays: 11, maxDays: 19,       rate: 1200 },
  { minDays: 20, maxDays: Infinity, rate: 1200 },
]

// ---------------------------------------------------------------------------
// Add-ons and surcharges
// ---------------------------------------------------------------------------

export const SMART_DIRECTIONAL_PER_TRUCK_DAY = 250
export const DEVICE_ID_PASSBACK_FLAT = 2500
export const HOUR_SURCHARGE_PER_HOUR = 150
export const STANDARD_HOURS = 8

// ---------------------------------------------------------------------------
// Shadow fencing (Tier 2 — always included in Better/Best)
// ---------------------------------------------------------------------------

export const SHADOW_FENCING_RATE = 0.25       // 25% of base media
export const SHADOW_FENCING_FLOOR = 5000      // minimum $5,000
export const SHADOW_FENCING_CPM = 10          // $10 CPM for digital impressions

// ---------------------------------------------------------------------------
// Lift studies (Tier 3)
// ---------------------------------------------------------------------------

export const STUDY_PRICE = 7500
export const STUDY_MIN_IMPRESSIONS = 1_200_000

export const VALID_STUDIES = [
  'web_lift',
  'foot_traffic',
  'sales_lift',
  'brand_lift',
] as const

export type StudyType = (typeof VALID_STUDIES)[number]

// ---------------------------------------------------------------------------
// Physical impressions model: A18+ per truck per operating day
// ---------------------------------------------------------------------------

export type MarketSizeTier = {
  id: number
  label: string
  short: string
  dailyA18: number
}

export const MARKET_SIZE_TIERS: MarketSizeTier[] = [
  { id: 1, label: 'Top 2 mega-DMAs',         short: 'Mega-DMA',    dailyA18: 90_000 },
  { id: 2, label: 'Top 10 major-metro DMAs',  short: 'Major-metro', dailyA18: 60_000 },
  { id: 3, label: 'Standard mid/large DMAs',  short: 'Mid/large',   dailyA18: 40_000 },
  { id: 4, label: 'Sub-DMA / small metro',    short: 'Small metro', dailyA18: 20_000 },
]

// ---------------------------------------------------------------------------
// DMA rank → market size tier mapping
// ---------------------------------------------------------------------------

/**
 * Maps a DMA code to a market size tier ID based on Nielsen rank.
 * Rank 1-2 → Tier 1 (mega-DMA), 3-10 → Tier 2 (major-metro),
 * 11-50 → Tier 3 (mid/large), everything else → Tier 4 (small metro).
 *
 * DMA codes are ordered by rank in the accepted markets seed — the rank
 * is implicit in the DMA code list order. This lookup uses the DMA code
 * directly since rank isn't stored in the database.
 */
const MEGA_DMA_CODES = new Set(['DMA-501', 'DMA-803'])                          // NY, LA
const MAJOR_METRO_DMA_CODES = new Set([
  'DMA-602', 'DMA-623', 'DMA-504', 'DMA-618', 'DMA-524', 'DMA-511',            // Chicago, Dallas, Philly, Houston, Atlanta, DC
  'DMA-807', 'DMA-506',                                                          // SF, Boston
])

export function marketSizeTierFromDmaCode(dmaCode: string): number {
  if (MEGA_DMA_CODES.has(dmaCode)) return 1
  if (MAJOR_METRO_DMA_CODES.has(dmaCode)) return 2
  return 3  // all other top-50 DMAs
}

// ---------------------------------------------------------------------------
// Service area & transport pricing (from transport spec v1, 30 July 2026)
// ---------------------------------------------------------------------------

// Inclusion zone: per-truck repositioning is absorbed within this radius.
// Beyond this distance, the truck incurs a billed transport charge.
export const SERVICE_AREA_RADIUS_MILES = 250

// Swarm threshold: campaigns requesting more than this many trucks trigger manual quote.
export const SWARM_TRUCK_LIMIT = 3

export const TRANSPORT_CONFIG = {
  // ---- revenue (reference only for margin check)
  ratePerTruckDay: 1200.00, // base-case modeling assumption, NOT the actual rate

  // ---- activation day cost (a paid day on a job)
  activationDay: {
    driver:    250.00,
    fuel:       50.00,
    insurance:  41.00,    // fixed; see fixedCostBasis
    repairs:    25.00,
    tech:        7.50,    // fixed; see fixedCostBasis
    // total: 373.50
  },

  // Insurance + tech: $970/truck/month allocated across booked days.
  // $48.50/day implies 20 booked days/month. THIS IS AN ASSUMPTION, not a measurement.
  // OPEN ITEM #1 — see transport spec §8
  fixedCostBasis: {
    monthlyFixedPerTruck: 970.00,
    assumedBookedDaysPerMonth: 20,
  },

  // ---- transport day cost (repositioning, no revenue)
  transportDay: {
    milesPerDay:  450,
    dieselPerGal: 3.75,
    mpg:          6.0,
    driver:       250.00,
    repairs:      25.00,
    // fuel = milesPerDay / mpg * dieselPerGal = 281.25
    // total = 556.25
  },

  airfareHomeOneWay:    350.00,
  tollsPerLeg:           40.00,
  hotelPerDiemPerNight: 210.00,

  // ---- policy thresholds
  minFlightDays:                3,
  standardLeadTimeBusinessDays: 10,

  // ---- exception billing
  exceptionTransportDayRate: 750.00,
  depositTransportDays: 1,

  // ---- internal reference only, never buyer-facing
  baseCaseGcPct: 0.426,
} as const

// ---------------------------------------------------------------------------
// Rate override shape (for Rate Agreements)
// ---------------------------------------------------------------------------

export type RateOverrides = {
  daily_rates?: Partial<Record<string, number>>   // e.g. { "1_1": 1700, "2_10": 1200 }
  shadow_fencing_pct?: number
  shadow_fencing_floor?: number
  smart_directional_daily?: number
  device_id_flat?: number
  study_cost?: number
  hour_surcharge?: number
}

/**
 * Convert a rate tier key like "2_10" to { minDays, maxDays }.
 */
export function parseTierKey(key: string): { minDays: number; maxDays: number } | null {
  const [lo, hi] = key.split('_').map(Number)
  if (isNaN(lo) || isNaN(hi)) return null
  return { minDays: lo, maxDays: hi === 999 ? Infinity : hi }
}

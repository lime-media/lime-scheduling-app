export { computeQuote, getDailyRate } from './engine'
export type { QuoteInput, QuoteResult, TierGood, TierBetter, TierBest } from './engine'

export {
  priceTransport,
  chargeForLeg,
  needsRepositioning,
  estimatedLegs,
  cancellationCharge,
  marginCheck,
  activationDayCost,
  absorbedLegCost,
  fuelPerTransportDay,
  transportDayCost,
  transportDaysFromDistance,
  MIN_ACTIVATION_DAYS_TO_ABSORB,
  MIN_LEAD_BUSINESS_DAYS_TO_ABSORB,
} from './transport'
export type {
  TransportOrder,
  TransportResult,
  TransportOutcome,
  TransportCostOverrides,
  TruckLeg,
  PricedLeg,
  MarginCheck,
} from './transport'

export { countActivationDays, countCalendarDays, defaultDaysPerWeek } from './schedule'

export { RATE_CARD, TRANSPORT_CONFIG, SERVICE_AREA_RADIUS_MILES, MARKET_SIZE_TIERS, VALID_STUDIES, SHADOW_FENCING_CPM, STUDY_PRICE, STUDY_MIN_IMPRESSIONS, marketSizeTierFromDmaCode } from './config'
export type { RateOverrides, StudyType, MarketSizeTier } from './config'

export { resolveMarketSizeTierId, resolveRateOverrides, resolveNearestAcceptedMarket, resolveCampaignCoords, businessDaysBetween } from './resolvers'
export type { NearestMarketResult, CampaignCoords } from './resolvers'

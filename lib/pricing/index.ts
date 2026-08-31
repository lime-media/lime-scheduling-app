export { computeQuote, getDailyRate } from './engine'
export type { QuoteInput, QuoteResult, TierGood, TierBetter, TierBest } from './engine'

export { priceTransport, cancellationCharge, marginCheck, activationDayCost, absorbedLegCost, fuelPerTransportDay, transportDayCost, transportDaysFromDistance } from './transport'
export type { TransportOrder, TransportResult, TransportIncluded, TransportBilled, TransportManualQuote, TransportTrigger, MarginCheck } from './transport'

export { RATE_CARD, TRANSPORT_CONFIG, SERVICE_AREA_RADIUS_MILES, SWARM_TRUCK_LIMIT, MARKET_SIZE_TIERS, VALID_STUDIES, SHADOW_FENCING_CPM, STUDY_PRICE, STUDY_MIN_IMPRESSIONS, marketSizeTierFromDmaCode } from './config'
export type { RateOverrides, StudyType, MarketSizeTier } from './config'

export { resolveMarketSizeTierId, resolveRateOverrides, resolveNearestAcceptedMarket, resolveCampaignCoords, businessDaysBetween } from './resolvers'
export type { NearestMarketResult, CampaignCoords } from './resolvers'

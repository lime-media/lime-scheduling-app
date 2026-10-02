/**
 * Which top-50 DMA a point belongs to, for the market size tier.
 *
 * The tier used to come from the market's NAME alone, so a suburb inside a
 * mega-DMA ("Evanston, IL", "Plano, TX") was priced on small-metro reach.
 * Now a market that is not itself a top-50 DMA city takes the tier of the
 * nearest active top-50 DMA whose centre is within DMA_RADIUS_MILES.
 *
 * Nielsen's DMA boundaries are proprietary, so this is a radius around each
 * DMA's centre (app_accepted_markets.lat/lng): it catches the suburban ring
 * of every top-50 metro and leaves separate towns — Ames, an hour from Des
 * Moines, which is not a top-50 DMA anyway — on the small-metro tier.
 */

import { haversineDistance } from '@/lib/marketCoordinates'

export const DMA_RADIUS_MILES = 40

/** The nearest DMA within the radius, or null. Pure. */
export function dmaForPoint<T extends { lat: number; lng: number }>(
  point: { lat: number; lng: number },
  dmas: T[],
  radiusMiles = DMA_RADIUS_MILES,
): T | null {
  let best: { dma: T; miles: number } | null = null
  for (const dma of dmas) {
    if (!Number.isFinite(dma.lat) || !Number.isFinite(dma.lng)) continue
    const miles = haversineDistance(point.lat, point.lng, dma.lat, dma.lng)
    if (miles <= radiusMiles && (!best || miles < best.miles)) best = { dma, miles }
  }
  return best?.dma ?? null
}

/**
 * Which top-50 DMA a point belongs to, for the market size tier.
 *
 * The tier used to come from the market's NAME alone, so a suburb inside a
 * mega-DMA ("Evanston, IL", "Plano, TX") was priced on small-metro reach.
 * Now a market that is not itself a top-50 DMA city takes the tier of the
 * nearest top-50 DMA with a centre within DMA_RADIUS_MILES.
 *
 * Nielsen's DMA boundaries are proprietary, so this is a radius around each
 * DMA's centre, and around its other principal cities where a polycentric
 * DMA has them (`also` in lib/pricing/topDmas.ts: San Jose, Fort Worth, the
 * Inland Empire). It catches the suburban ring of every top-50 metro and
 * leaves separate towns — Ames, an hour from Des Moines, which is not a
 * top-50 DMA anyway — on the small-metro tier.
 */

import { haversineDistance } from '@/lib/marketCoordinates'

export const DMA_RADIUS_MILES = 40

type Point = { lat: number; lng: number }

/** The DMA with the nearest centre within the radius, or null. Pure. */
export function dmaForPoint<T extends Point & { also?: readonly Point[] }>(
  point: Point,
  dmas: readonly T[],
  radiusMiles = DMA_RADIUS_MILES,
): T | null {
  let best: { dma: T; miles: number } | null = null
  for (const dma of dmas) {
    for (const centre of [dma, ...(dma.also ?? [])]) {
      if (!Number.isFinite(centre.lat) || !Number.isFinite(centre.lng)) continue
      const miles = haversineDistance(point.lat, point.lng, centre.lat, centre.lng)
      if (miles <= radiusMiles && (!best || miles < best.miles)) best = { dma, miles }
    }
  }
  return best?.dma ?? null
}

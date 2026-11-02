/**
 * LED standard market for a hold (lib/standardMarkets.ts): by name, else by the
 * area that holds the town, and which areas are trusted. Pure functions only.
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { normalizeMarketKey } from '@/lib/marketBounds'
import { boxIsWhereItsCityIs, pickStandardMarket, type StandardMarket } from '@/lib/standardMarkets'

section('LED standard market for a hold (lib/standardMarkets.ts)')
{
  const box = (lat: number, lng: number, r = 0.3) => ({ ne_lat: lat + r, ne_lng: lng + r, sw_lat: lat - r, sw_lng: lng - r })
  const SM: StandardMarket[] = [
    { uid: 'DAL', key: 'dallas, tx', box: box(32.78, -96.8, 0.6) },
    { uid: 'FTW-AREA', key: 'arlington, tx', box: box(32.74, -97.1, 0.6) },
    { uid: 'PDX', key: 'portland, or', box: box(45.52, -122.68) },
    { uid: 'PWM', key: 'portland, me', box: box(43.66, -70.26) },
    { uid: 'NOBOX', key: 'ames, ia', box: null },
  ]
  const places: Record<string, { lat: number; lng: number }> = {
    'fort worth, tx': { lat: 32.75, lng: -97.33 },
    'plano, tx': { lat: 33.02, lng: -96.7 },
    'ames, ia': { lat: 42.03, lng: -93.62 },
    'tiny town, ks': { lat: 38.0, lng: -99.0 },
  }
  const locate = (m: string) => places[normalizeMarketKey(m)] ?? null
  eq('a standard market by name', pickStandardMarket('Dallas, TX', 'TX', SM, locate), { uid: 'DAL', via: 'name' })
  eq('name match ignores case and spacing', pickStandardMarket('  dallas ,tx', undefined, SM, locate)?.uid, 'DAL')
  eq('state picks between same-named markets', pickStandardMarket('Portland', 'ME', SM, locate)?.uid, 'PWM')
  eq('a town inside one market\'s area', pickStandardMarket('Plano, TX', 'TX', SM, locate), { uid: 'DAL', via: 'area' })
  // Fort Worth sits in both boxes; Arlington's centre is nearer.
  eq('overlapping areas: the nearest centre wins', pickStandardMarket('Fort Worth, TX', 'TX', SM, locate)?.uid, 'FTW-AREA')
  eq('a name match needs no area', pickStandardMarket('Ames, IA', 'IA', SM, locate)?.uid, 'NOBOX')
  eq('a town in no market\'s area is unset', pickStandardMarket('Tiny Town, KS', 'KS', SM, locate), null)
  eq('a multi-market label is unset', pickStandardMarket('Multi-market: Dallas, Portland', undefined, SM, locate), null)
  eq('blank is unset', pickStandardMarket('  ', undefined, SM, locate), null)
}
{
  const at = (lat: number, lng: number) => ({ ne_lat: lat + 0.2, ne_lng: lng + 0.2, sw_lat: lat - 0.2, sw_lng: lng - 0.2 })
  const city = (m: string) => ({ 'sherman, tx': { lat: 33.64, lng: -96.61 }, 'dallas, tx': { lat: 32.78, lng: -96.8 } } as Record<string, { lat: number; lng: number }>)[m] ?? null
  eq('an area on its own city is trusted', boxIsWhereItsCityIs({ uid: 'D', key: 'dallas, tx', box: at(32.78, -96.8) }, city), true)
  // Sherman, TX's row has a box in the panhandle, 350 miles away.
  eq('an area far from its city is not', boxIsWhereItsCityIs({ uid: 'S', key: 'sherman, tx', box: at(36.25, -101.89) }, city), false)
  eq('a city not in the place list is trusted', boxIsWhereItsCityIs({ uid: 'X', key: 'stanford / stamford, ct', box: at(41.05, -73.54) }, city), true)
}

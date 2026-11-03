/**
 * Nielsen's top-50 DMAs: reference data for the market size tier only
 * (lib/pricing/config.ts marketSizeTierFromDmaCode), never a list of markets.
 * Markets are LED's standard markets (dbo.standard_market_lookup); a market
 * takes the tier of the top-50 DMA it is named for or sits in
 * (lib/pricing/dmaArea.ts); the tier of each code is in lib/pricing/config.ts.
 * Copied from app_accepted_markets (all 50 rows active), which this replaces.
 *
 * `also` lists a polycentric DMA's other principal cities, where the ring
 * around its centre misses them (San Jose is 47 miles from San Francisco's
 * centre): the cities in Nielsen's DMA name, plus the Inland Empire for Los
 * Angeles and the Lehigh Valley, Galveston and Fort Collins, whose counties
 * are in the DMA. Where a full ring would reach a DMA outside the top 50, the
 * centre has a smaller one (`miles`): San Jose stops short of Santa Cruz,
 * Reading and Allentown of Schuylkill and Carbon Counties, Canton of Salem,
 * Kalamazoo of Three Rivers, Sarasota of Port Charlotte.
 * Fayetteville (Raleigh-Durham) is left out: its ring would reach Lumberton,
 * in a DMA outside the top 50, and an overstated reach is the worse error.
 */
export type TopDma = {
  dma_code: string
  dma_name: string
  lat: number
  lng: number
  /** The DMA's other principal cities, each a centre of its own ring
   *  (lib/pricing/dmaArea.ts). */
  also?: readonly DmaCentre[]
}
/** `miles`: a smaller ring where the full one would reach into a DMA outside the top 50. */
export type DmaCentre = { name: string; lat: number; lng: number; miles?: number }

export const TOP_DMAS: readonly TopDma[] = [
  { dma_code: 'DMA-501', dma_name: 'New York, NY', lat: 40.7128, lng: -74.006 },
  { dma_code: 'DMA-504', dma_name: 'Philadelphia, PA', lat: 39.9526, lng: -75.1652,
    also: [{ name: 'Reading, PA', lat: 40.3392, lng: -75.9263, miles: 19 }, { name: 'Allentown, PA', lat: 40.5936, lng: -75.4784, miles: 15.5 }] },
  { dma_code: 'DMA-505', dma_name: 'Detroit, MI', lat: 42.3314, lng: -83.0458 },
  { dma_code: 'DMA-506', dma_name: 'Boston, MA', lat: 42.3601, lng: -71.0589 },
  { dma_code: 'DMA-508', dma_name: 'Pittsburgh, PA', lat: 40.4406, lng: -79.9959 },
  { dma_code: 'DMA-510', dma_name: 'Cleveland, OH', lat: 41.4993, lng: -81.6944,
    also: [{ name: 'Canton, OH', lat: 40.8077, lng: -81.3672, miles: 25 }] },
  { dma_code: 'DMA-511', dma_name: 'Washington, DC', lat: 38.9072, lng: -77.0369 },
  { dma_code: 'DMA-512', dma_name: 'Baltimore, MD', lat: 39.2904, lng: -76.6122 },
  { dma_code: 'DMA-515', dma_name: 'Cincinnati, OH', lat: 39.1031, lng: -84.512 },
  { dma_code: 'DMA-517', dma_name: 'Charlotte, NC', lat: 35.2271, lng: -80.8431 },
  { dma_code: 'DMA-518', dma_name: 'Greensboro, NC', lat: 36.0726, lng: -79.792 },
  { dma_code: 'DMA-524', dma_name: 'Atlanta, GA', lat: 33.749, lng: -84.388 },
  { dma_code: 'DMA-527', dma_name: 'Indianapolis, IN', lat: 39.7684, lng: -86.1581 },
  { dma_code: 'DMA-528', dma_name: 'Miami, FL', lat: 25.7617, lng: -80.1918 },
  { dma_code: 'DMA-529', dma_name: 'Louisville, KY', lat: 38.2527, lng: -85.7585 },
  { dma_code: 'DMA-533', dma_name: 'Hartford, CT', lat: 41.7658, lng: -72.6734 },
  { dma_code: 'DMA-534', dma_name: 'Orlando, FL', lat: 28.5383, lng: -81.3792,
    also: [{ name: 'Daytona Beach, FL', lat: 29.1907, lng: -81.0971 }, { name: 'Melbourne, FL', lat: 28.1104, lng: -80.6627 }] },
  { dma_code: 'DMA-535', dma_name: 'Columbus, OH', lat: 39.9612, lng: -82.9988 },
  { dma_code: 'DMA-539', dma_name: 'Tampa, FL', lat: 27.9506, lng: -82.4572,
    also: [{ name: 'Sarasota, FL', lat: 27.3383, lng: -82.5437, miles: 30 }] },
  { dma_code: 'DMA-544', dma_name: 'Norfolk, VA', lat: 36.8508, lng: -76.2859 },
  { dma_code: 'DMA-548', dma_name: 'West Palm Beach, FL', lat: 26.7153, lng: -80.0534,
    also: [{ name: 'Fort Pierce, FL', lat: 27.4261, lng: -80.3425 }] },
  { dma_code: 'DMA-560', dma_name: 'Raleigh-Durham, NC', lat: 35.7796, lng: -78.6382 },
  { dma_code: 'DMA-561', dma_name: 'Jacksonville, FL', lat: 30.3322, lng: -81.6557 },
  { dma_code: 'DMA-563', dma_name: 'Grand Rapids, MI', lat: 42.9634, lng: -85.6681,
    also: [{ name: 'Kalamazoo, MI', lat: 42.2752, lng: -85.5885, miles: 20 }] },
  { dma_code: 'DMA-566', dma_name: 'Harrisburg, PA', lat: 40.2732, lng: -76.8867 },
  { dma_code: 'DMA-567', dma_name: 'Greenville, SC', lat: 34.8526, lng: -82.394,
    also: [{ name: 'Asheville, NC', lat: 35.571, lng: -82.5527 }] },
  { dma_code: 'DMA-602', dma_name: 'Chicago, IL', lat: 41.8781, lng: -87.6298 },
  { dma_code: 'DMA-609', dma_name: 'St. Louis, MO', lat: 38.627, lng: -90.1994 },
  { dma_code: 'DMA-613', dma_name: 'Minneapolis, MN', lat: 44.9778, lng: -93.265 },
  { dma_code: 'DMA-616', dma_name: 'Kansas City, MO', lat: 39.0997, lng: -94.5786 },
  { dma_code: 'DMA-617', dma_name: 'Milwaukee, WI', lat: 43.0389, lng: -87.9065 },
  { dma_code: 'DMA-618', dma_name: 'Houston, TX', lat: 29.7604, lng: -95.3698,
    also: [{ name: 'Galveston, TX', lat: 29.1863, lng: -94.9658 }] },
  { dma_code: 'DMA-622', dma_name: 'New Orleans, LA', lat: 29.9511, lng: -90.0715 },
  { dma_code: 'DMA-623', dma_name: 'Dallas-Fort Worth, TX', lat: 32.7767, lng: -96.797,
    also: [{ name: 'Fort Worth, TX', lat: 32.782, lng: -97.3486 }] },
  { dma_code: 'DMA-630', dma_name: 'Birmingham, AL', lat: 33.5186, lng: -86.8104 },
  { dma_code: 'DMA-635', dma_name: 'Austin, TX', lat: 30.2672, lng: -97.7431 },
  { dma_code: 'DMA-641', dma_name: 'San Antonio, TX', lat: 29.4241, lng: -98.4936 },
  { dma_code: 'DMA-650', dma_name: 'Oklahoma City, OK', lat: 35.4676, lng: -97.5164 },
  { dma_code: 'DMA-659', dma_name: 'Nashville, TN', lat: 36.1627, lng: -86.7816 },
  { dma_code: 'DMA-751', dma_name: 'Denver, CO', lat: 39.7392, lng: -104.9903,
    also: [{ name: 'Fort Collins, CO', lat: 40.5482, lng: -105.0648 }] },
  { dma_code: 'DMA-753', dma_name: 'Phoenix, AZ', lat: 33.4484, lng: -112.074 },
  { dma_code: 'DMA-770', dma_name: 'Salt Lake City, UT', lat: 40.7608, lng: -111.891 },
  { dma_code: 'DMA-790', dma_name: 'Albuquerque, NM', lat: 35.0844, lng: -106.6504,
    also: [{ name: 'Santa Fe, NM', lat: 35.662, lng: -105.9818 }] },
  { dma_code: 'DMA-803', dma_name: 'Los Angeles, CA', lat: 34.0522, lng: -118.2437,
    also: [{ name: 'Riverside, CA', lat: 33.9381, lng: -117.3932 }, { name: 'San Bernardino, CA', lat: 34.1411, lng: -117.2946 }] },
  { dma_code: 'DMA-807', dma_name: 'San Francisco, CA', lat: 37.7749, lng: -122.4194,
    also: [{ name: 'San Jose, CA', lat: 37.296, lng: -121.8146, miles: 18 }] },
  { dma_code: 'DMA-819', dma_name: 'Seattle, WA', lat: 47.6062, lng: -122.3321 },
  { dma_code: 'DMA-820', dma_name: 'Portland, OR', lat: 45.5152, lng: -122.6784 },
  { dma_code: 'DMA-825', dma_name: 'San Diego, CA', lat: 32.7157, lng: -117.1611 },
  { dma_code: 'DMA-839', dma_name: 'Las Vegas, NV', lat: 36.1699, lng: -115.1398 },
  { dma_code: 'DMA-862', dma_name: 'Sacramento, CA', lat: 38.5816, lng: -121.4944,
    also: [{ name: 'Stockton, CA', lat: 37.9766, lng: -121.3086 }] },
]

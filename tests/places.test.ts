/**
 * Any US place in a quote, and the location-based market size tier.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { findPlaces, placeCoords, placeForZip, suggestPlaces, withStateComma } from '@/lib/geo/places'
import { dmaForPoint, DMA_RADIUS_MILES } from '@/lib/pricing/dmaArea'
import { TOP_DMAS } from '@/lib/pricing/topDmas'

section('places: any US city or town can be quoted')
eq('Ames, IA (the college town north of Des Moines)', findPlaces('Ames, IA').map(p => p.name), ['Ames, IA'])
eq('case and spacing do not matter', findPlaces('  ames ,ia ').map(p => p.name), ['Ames, IA'])
eq('a city with no state lists every state that has one', findPlaces('Ames').map(p => p.name).includes('Ames, IA') && findPlaces('Ames').length > 1, true)
eq('a stated state is a constraint, never a hint', findPlaces('Ames, ZZ'), [])
eq('State College, PA', findPlaces('State College, PA').map(p => p.name), ['State College, PA'])
eq("the Census suffix is gone: 'Boise City' answers to Boise", findPlaces('Boise, ID').map(p => p.name), ['Boise, ID'])
eq('spelling is kept: McAllen, not Mcallen', findPlaces('mcallen, tx')[0]?.name, 'McAllen, TX')
eq('Alaska, Hawaii and Puerto Rico are not served', [findPlaces('Anchorage, AK').length, findPlaces('Honolulu, HI').length], [0, 0])
eq('nothing for nonsense', findPlaces('Qqqqzzz'), [])

section('places: ZIP codes')
eq('50010 is Ames, IA', placeForZip('50010')?.name, 'Ames, IA')
eq('a ZIP goes through the same lookup', findPlaces('50010').map(p => p.name), ['Ames, IA'])
eq('not a ZIP', placeForZip('5001'), null)

section('places: suggestions as you type')
eq('"Ame" suggests Ames, IA', suggestPlaces('Ame').some(p => p.name === 'Ames, IA'), true)
eq('a state narrows them', suggestPlaces('Ames, i').map(p => p.name).every(n => n.endsWith(', IA') || n.endsWith(', IL') || n.endsWith(', IN') || n.endsWith(', ID')), true)
eq('too short to suggest', suggestPlaces('Am'), [])
eq('at most 8', suggestPlaces('San').length <= 8, true)

section('places: a hold in a new market can still locate itself')
eq('market and state stored apart', placeCoords('Ames', 'IA')?.name, 'Ames, IA')
eq('market with its state', placeCoords('Ames, IA', 'IA')?.name, 'Ames, IA')

section('market size tier: by location, not just by name')
{
  const dmas = [
    { dma_code: 'DMA-602', name: 'Chicago', lat: 41.8781, lng: -87.6298 },
    { dma_code: 'DMA-623', name: 'Dallas-Fort Worth', lat: 32.7767, lng: -96.797 },
    { dma_code: 'DMA-511', name: 'Washington', lat: 38.9072, lng: -77.0369 },
    { dma_code: 'DMA-512', name: 'Baltimore', lat: 39.2904, lng: -76.6122 },
  ]
  const at = (place: string) => dmaForPoint(placeCoords(place)!, dmas)?.name ?? null
  eq('Evanston, IL is in the Chicago ring', at('Evanston, IL'), 'Chicago')
  eq('Plano, TX is in the Dallas-Fort Worth ring', at('Plano, TX'), 'Dallas-Fort Worth')
  eq('Fort Worth, TX too', at('Fort Worth, TX'), 'Dallas-Fort Worth')
  eq('between two DMAs, the nearer wins (Silver Spring: Washington)', at('Silver Spring, MD'), 'Washington')
  eq('Ames, IA is in no top-50 ring: small metro', at('Ames, IA'), null)
  eq(`the ring is ${DMA_RADIUS_MILES} miles`, DMA_RADIUS_MILES, 40)
}

section('market size tier: a polycentric DMA has a centre at each principal city')
{
  const at = (place: string) => dmaForPoint(placeCoords(place)!, TOP_DMAS)?.dma_name ?? null
  eq('San Jose, CA (47 miles from San Francisco) is in the SF DMA', at('San Jose, CA'), 'San Francisco, CA')
  eq('Weatherford, TX (west of Fort Worth) is in Dallas-Fort Worth', at('Weatherford, TX'), 'Dallas-Fort Worth, TX')
  eq('Riverside, CA is in Los Angeles', at('Riverside, CA'), 'Los Angeles, CA')
  eq('Daytona Beach, FL is in Orlando', at('Daytona Beach, FL'), 'Orlando, FL')
  eq('Lancaster, PA stays in Harrisburg, though Reading is a Philadelphia centre', at('Lancaster, PA'), 'Harrisburg, PA')
  eq('Ephrata, PA (Lancaster County) is in Harrisburg, not Philadelphia', at('Ephrata, PA'), 'Harrisburg, PA')
  eq('Coatesville, PA is in Philadelphia', at('Coatesville, PA'), 'Philadelphia, PA')
  eq('Allentown, PA is in Philadelphia', at('Allentown, PA'), 'Philadelphia, PA')
  eq('Lumberton, NC (Florence-Myrtle Beach DMA) stays a small metro', at('Lumberton, NC'), null)
  eq('Morgan Hill, CA is in the SF DMA', at('Morgan Hill, CA'), 'San Francisco, CA')
  eq('Battle Creek, MI is in Grand Rapids', at('Battle Creek, MI'), 'Grand Rapids, MI')
  eq('New Philadelphia, OH is in Cleveland', at('New Philadelphia, OH'), 'Cleveland, OH')
  eq('North Port, FL is in Tampa', at('North Port, FL'), 'Tampa, FL')
  // A smaller ring where the full one would reach a DMA outside the top 50
  eq('Santa Cruz, CA (Monterey-Salinas DMA) stays a small metro', at('Santa Cruz, CA'), null)
  eq('Pottsville, PA (Wilkes-Barre DMA) stays a small metro', at('Pottsville, PA'), null)
  eq('Lehighton, PA (Wilkes-Barre DMA) stays a small metro', at('Lehighton, PA'), null)
  eq('Palmerton, PA (Wilkes-Barre DMA) stays a small metro', at('Palmerton, PA'), null)
  eq('Auburn, PA (Wilkes-Barre DMA) stays a small metro', at('Auburn, PA'), null)
  eq('Easton, PA is in Philadelphia', at('Easton, PA'), 'Philadelphia, PA')
  eq('Kutztown, PA is in Philadelphia', at('Kutztown, PA'), 'Philadelphia, PA')
  eq('Salem, OH (Youngstown DMA) stays a small metro', at('Salem, OH'), null)
  eq('Three Rivers, MI (South Bend DMA) stays a small metro', at('Three Rivers, MI'), null)
  eq('Port Charlotte, FL (Fort Myers DMA) stays a small metro', at('Port Charlotte, FL'), null)
  eq('Merced, CA (Fresno DMA) stays a small metro', at('Merced, CA'), null)
  eq('Lansing, MI stays a small metro', at('Lansing, MI'), null)
  eq('Ames, IA stays a small metro', at('Ames, IA'), null)
  eq('every extra centre is in the contiguous 48', TOP_DMAS.flatMap(d => d.also ?? []).every(c => c.lat > 24 && c.lat < 50 && c.lng > -125 && c.lng < -66), true)
}

section('places: review fixes — punctuated names and a missing comma')
eq('St. Louis, MO (a period in the name)', placeCoords('St. Louis, MO')?.name, 'St. Louis, MO')
eq('and without the period', placeCoords('St Louis, MO')?.name, 'St. Louis, MO')
eq('East St. Louis, IL — a place the standard list does not have', findPlaces('East St Louis, IL').map(p => p.name), ['East St. Louis, IL'])
eq('suggestions reach punctuated names', suggestPlaces('east st. lou').some(p => p.name === 'East St. Louis, IL'), true)
eq('"Ames IA" without the comma', findPlaces('Ames IA').map(p => p.name), ['Ames, IA'])
eq('"New York NY"', withStateComma('New York NY'), 'New York, NY')
eq('two letters that are no state are left alone', withStateComma('Ponte Vedra Xq'), 'Ponte Vedra Xq')
eq('a comma already there is left alone', withStateComma('Ames, IA'), 'Ames, IA')

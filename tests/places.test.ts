/**
 * Any US place in a quote, and the location-based market size tier.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { findPlaces, placeCoords, placeForZip, suggestPlaces, withStateComma } from '@/lib/geo/places'
import { dmaForPoint, DMA_RADIUS_MILES } from '@/lib/pricing/dmaArea'

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

section('places: review fixes — punctuated names and a missing comma')
eq('St. Louis, MO (a period in the name)', placeCoords('St. Louis, MO')?.name, 'St. Louis, MO')
eq('and without the period', placeCoords('St Louis, MO')?.name, 'St. Louis, MO')
eq('East St. Louis, IL — a place the standard list does not have', findPlaces('East St Louis, IL').map(p => p.name), ['East St. Louis, IL'])
eq('suggestions reach punctuated names', suggestPlaces('east st. lou').some(p => p.name === 'East St. Louis, IL'), true)
eq('"Ames IA" without the comma', findPlaces('Ames IA').map(p => p.name), ['Ames, IA'])
eq('"New York NY"', withStateComma('New York NY'), 'New York, NY')
eq('two letters that are no state are left alone', withStateComma('Ponte Vedra Xq'), 'Ponte Vedra Xq')
eq('a comma already there is left alone', withStateComma('Ames, IA'), 'Ames, IA')

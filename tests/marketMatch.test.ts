/**
 * The one market matcher (lib/marketMatch.ts): obvious matches default,
 * less obvious ones are picked from candidates, and nothing is added to the list.
 */
import { eq, section } from './harness'
import { matchMarket, readMarketText, unattendedChoice, NEAREST_OFFERED } from '@/lib/marketMatch'
import { readMatchQuery } from '@/lib/marketMatchQuery'
import type { StandardMarket } from '@/lib/standardMarkets'

const box = (lat: number, lng: number, r = 0.5) => ({ ne_lat: lat + r, ne_lng: lng + r, sw_lat: lat - r, sw_lng: lng - r })
const m = (uid: string, name: string, b: StandardMarket['box'] = null): StandardMarket => ({ uid, key: name.toLowerCase().replace(/\s*,\s*/g, ', '), name, box: b })
const LIST: StandardMarket[] = [
  m('DAL', 'Dallas, TX', box(32.78, -96.8)),
  m('KCMO', 'Kansas City, MO', box(39.1, -94.58)),
  m('KCKS', 'Kansas City, KS', box(39.11, -94.63)),
  m('ALL', 'Allentown, PA', box(40.6, -75.47)),
  m('SIL', 'Springfield, IL', box(39.8, -89.65)),
  m('SMO', 'Springfield, MO', box(37.2, -93.29)),
  m('JAX', 'Jacksonville, FL', box(30.33, -81.66)),
  m('NNJ', 'Northern NJ', box(40.9, -74.2)),
]
// Places the tests use; anything else isn't located.
const PLACES: Record<string, { lat: number; lng: number }> = {
  'plano, tx': { lat: 32.9, lng: -96.7 },          // inside Dallas's area
  'dallas, pa': { lat: 41.33, lng: -75.96 },        // no market area; nearest offered
  'overland park, ks': { lat: 39.1, lng: -94.6 },   // inside both Kansas City areas
}
const locate = (text: string, state?: string) => {
  const k = text.toLowerCase().replace(/\s*,\s*/g, ', ').trim()
  return PLACES[k] ?? (state ? PLACES[`${k}, ${state.toLowerCase()}`] : undefined) ?? null
}
const match = (text: string, state?: string) => matchMarket(text, state, LIST, locate)
const got = (text: string, state?: string) => { const r = match(text, state); return [r.obvious, r.choice?.uid ?? null, r.candidates.map(c => c.uid), r.via] }

section('marketMatch: obvious matches default to the list entry')
eq('the list\'s own name', got('Dallas, TX'), [true, 'DAL', ['DAL'], 'name'])
eq('no comma', got('Dallas TX'), [true, 'DAL', ['DAL'], 'name'])
eq('an entry named without a state', got('Northern NJ'), [true, 'NNJ', ['NNJ'], 'name'])
eq('a state written another way', got('Dallas, Tex'), [true, 'DAL', ['DAL'], 'city'])
eq('a full state name and a ZIP', got('Dallas, Texas 75201'), [true, 'DAL', ['DAL'], 'city'])
eq('a two-state metro: its first state', got('Kansas City, MO-KS'), [true, 'KCMO', ['KCMO'], 'city'])
eq('the form\'s separate state', got('Kansas City', 'KS'), [true, 'KCKS', ['KCKS'], 'name'])
eq('a city the list has once', got('Allentown'), [true, 'ALL', ['ALL'], 'city'])
eq('a state named in region text', got('Allentown, Lehigh Valley PA'), [true, 'ALL', ['ALL'], 'city'])
eq('a town inside one market\'s area', got('Plano, TX'), [true, 'DAL', ['DAL'], 'area'])

section('marketMatch: less obvious ones are picked from candidates')
eq('a city the list has in two states', got('Springfield'), [false, null, ['SIL', 'SMO'], 'city'])
eq('two Kansas Citys, no state', got('Kansas City'), [false, null, ['KCKS', 'KCMO'], 'city'])
eq('region text: never obvious, even with one entry', got('Allentown, Lehigh Valley'), [false, null, ['ALL'], 'city'])
eq('county text is a region, not Colorado', got('Dallas, Luzerne County'), [false, null, ['DAL'], 'city'])
eq('"Co" for County is not Colorado', readMarketText('Aurora, Kane Co'), { city: 'aurora', qualifier: 'region' })
eq('a misspelled state: picked, never another state\'s city', got('Dallas, Pensylvania'), [false, null, ['DAL'], 'city'])
eq('a town inside two overlapping areas, nearest first', got('Overland Park, KS'), [false, null, ['KCMO', 'KCKS'], 'area'])
eq('a stated state never takes another state\'s city', match('Dallas, PA').candidates.some(c => c.uid === 'DAL') && match('Dallas, PA').choice?.uid === 'DAL', false)
eq('not on the list: the nearest markets are offered', [match('Dallas, PA').obvious, match('Dallas, PA').via, match('Dallas, PA').candidates[0]?.uid, match('Dallas, PA').candidates.length], [false, 'nearest', 'ALL', NEAREST_OFFERED])
eq('not on the list and not located: nothing', got('Nowheresville, ZZ'), [false, null, [], 'none'])
eq('blank: nothing', got('  '), [false, null, [], 'none'])

section('marketMatch: filing with no one to ask (the LED sweep)')
eq('an obvious match files under it', unattendedChoice(match('Plano, TX'))?.uid, 'DAL')
eq('overlapping areas: the nearest, as the sweep files today', unattendedChoice(match('Overland Park, KS'))?.uid, 'KCMO')
eq('two cities by name: never guessed', unattendedChoice(match('Springfield')), null)
eq('region text with one entry: not filed by name alone', unattendedChoice(match('Allentown, Lehigh Valley')), null)
eq('outside every area: not filed under the nearest', unattendedChoice(match('Dallas, PA')), null)

section('marketMatch: reading market text')
eq('a lowercase trailing code in region text is not trusted', readMarketText('pittsburgh, western pa').state, undefined)
eq('a capital one is', readMarketText('Pittsburgh, Western PA').state, 'pa')
eq('"La Jolla" is not Louisiana', readMarketText('San Diego, La Jolla').state, undefined)
eq('a whole lowercase code after the comma is a state', readMarketText('dallas, tx').state, 'tx')
eq('a country after the state', readMarketText('Dallas, TX, USA').state, 'tx')
eq('a ZIP alone names no state', readMarketText('Allentown, 18101'), { city: 'allentown' })
eq('dots dropped', readMarketText('St. Louis, Mo.').state, 'mo')

section('marketMatch: the match routes\' query')
eq('market text and a state', readMatchQuery(new URLSearchParams('q=Dallas&state=tx')), { text: 'Dallas', state: 'tx' })
eq('too short', 'error' in readMatchQuery(new URLSearchParams('q=D')), true)
eq('a state that isn\'t two letters', 'error' in readMatchQuery(new URLSearchParams('q=Dallas&state=Texas')), true)

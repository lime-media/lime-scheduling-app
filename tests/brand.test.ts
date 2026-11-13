/**
 * The quote's brand field: what goes to Salesforce, and the Opportunity name.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { brandChange, cleanBrand, isNoBrand, opportunityName, readBrand, savedBrand } from '@/lib/brand'

section('brand: only the brand is saved')
eq('a plain brand', cleanBrand('  Nike  '), 'Nike')
eq('month and asset type dropped', cleanBrand('Molytical August LED'), 'Molytical')
eq('asset type dropped', cleanBrand('Hannah Anderson Airstream'), 'Hannah Anderson')
eq('a two-word asset type', cleanBrand('Celsius Glass Truck'), 'Celsius')
eq('year and descriptor dropped', cleanBrand('Red Bull Tour 2026'), 'Red Bull')
eq("a short year", cleanBrand("Monster '26"), 'Monster')
eq('a brand that contains such a word is left alone', cleanBrand('Build-A-Bear'), 'Build-A-Bear')
eq('Busch is not a bus', cleanBrand('Busch Light'), 'Busch Light')
eq('never stripped to nothing', cleanBrand('LED'), 'LED')
eq('at most 50 characters', cleanBrand('A'.repeat(60)).length, 50)
eq('empty stays empty', cleanBrand(''), '')

section('brand: cleaning a saved brand again changes nothing')
// Long names where the 50-character cut leaves a trailing descriptor, a month,
// a year or an asset type for the next clean to drop.
const tricky = [
  'Acme Regional Sporting Goods Holiday Season Kickoff Tour August LED',
  'Acme Regional Sporting Goods Holiday Season 2026 Kickoff Tour LED',
  'Acme Regional Sporting Goods Holiday Promotion Tour Extension 2026',
  'Northwest Coastal Outdoor Recreation and Supply Co. LED Truck Tour',
  'Big   Spaces   Between   Words   In   A   Very   Long   Brand   Name   2026',
  'A'.repeat(45) + ' Tour of the Year',
  'A'.repeat(44) + ' - LED - August',
  'B'.repeat(46) + ' Van Tour',
  'Punctuation, Commas, and/or Slashes / Everywhere — Airstream / 2026',
  'Short Brand',
  'LED',
  '',
]
for (const raw of tricky) {
  const once = cleanBrand(raw)
  eq(`idempotent: ${JSON.stringify(raw.slice(0, 40))}`, cleanBrand(once), once)
  eq(`at most 50: ${JSON.stringify(raw.slice(0, 40))}`, once.length <= 50, true)
}
eq('a cut that ends on a descriptor drops it', cleanBrand('A'.repeat(45) + ' Tour of the Year'), 'A'.repeat(45))

section('brand: it leads the Opportunity name')
eq('brand first, Closed Won form', opportunityName('Nike', 'Rolling Adz', '2026-10-02'), 'Nike / Rolling Adz / 2026-10-02')
eq('no brand: account / date', opportunityName('', 'Rolling Adz', '2026-10-02'), 'Rolling Adz / 2026-10-02')
eq('Salesforce limit of 120', opportunityName('B'.repeat(50), 'A'.repeat(60), 'x'.repeat(40)).length, 120)

section('brand: the page says why the saved value differs')
eq('nothing changed', brandChange('Nike'), 'none')
eq('extra spaces are not a change', brandChange('  Nike  '), 'none')
eq('words dropped', brandChange('Molytical August LED'), 'stripped')
eq('only cut to 50 characters (nothing dropped)', brandChange('A'.repeat(60)), 'cut')
eq('both: says what was dropped', brandChange('A'.repeat(60) + ' LED'), 'stripped')

section('readBrand: the chat and MCP ask, never assume (F6)')
eq('a brand', readBrand('Nike LED', true), { brand: 'Nike' })
eq('"none" is an answer: no brand', [readBrand('none', true), readBrand(' No Brand ', true), readBrand('N/A', true)], [{ brand: '' }, { brand: '' }, { brand: '' }])
eq('missing, when required: refused', 'error' in readBrand(undefined, true) && 'error' in readBrand('  ', true), true)
eq('"none." and "n.a." are answers too', [readBrand('None.', true), readBrand('n.a.', true)], [{ brand: '' }, { brand: '' }])
eq('missing on the Quote page: no brand', readBrand(undefined, false), { brand: '' })
eq('savedBrand: none is no brand, a brand is cleaned', [savedBrand('None'), savedBrand('Nike LED'), savedBrand(undefined)], ['', 'Nike', ''])
eq('"no  brand" and "no-brand" are answers too (spacing, hyphen)', [readBrand('no  brand', true), readBrand('No-Brand', true)], [{ brand: '' }, { brand: '' }])
eq('isNoBrand: only the no-brand answers', [isNoBrand('None'), isNoBrand(' n/a '), isNoBrand('Nike'), isNoBrand(''), isNoBrand(undefined)], [true, true, false, false, false])
eq('a brand called NA is kept', savedBrand('NA'), 'NA')
eq('a no-brand answer with a trailing descriptor is still no brand', [savedBrand('N/A LED'), savedBrand('None 2026')], ['', ''])

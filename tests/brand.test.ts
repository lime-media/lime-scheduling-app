/**
 * The quote's brand field: what goes to Salesforce, and the Opportunity name.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { brandChange, cleanBrand, opportunityName } from '@/lib/brand'

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

section('brand: it leads the Opportunity name')
eq('brand first', opportunityName('Nike', 'Rolling Adz', 'Des Moines, IA - 2026-10-02 to 2026-10-03'), 'Nike / Rolling Adz - Des Moines, IA - 2026-10-02 to 2026-10-03')
eq('no brand: as before', opportunityName('', 'Rolling Adz', 'Des Moines, IA - 2026-10-02 to 2026-10-03'), 'Rolling Adz - Des Moines, IA - 2026-10-02 to 2026-10-03')
eq('Salesforce limit of 120', opportunityName('B'.repeat(50), 'A'.repeat(60), 'x'.repeat(40)).length, 120)

section('brand: the page says why the saved value differs')
eq('nothing changed', brandChange('Nike'), 'none')
eq('extra spaces are not a change', brandChange('  Nike  '), 'none')
eq('words dropped', brandChange('Molytical August LED'), 'stripped')
eq('only cut to 50 characters (nothing dropped)', brandChange('A'.repeat(60)), 'cut')
eq('both: says what was dropped', brandChange('A'.repeat(60) + ' LED'), 'stripped')

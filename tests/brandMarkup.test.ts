/**
 * Brand Direct markup — pure-function coverage.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { brandMarkupAmount, clampBrandMarkup, clientTypeOf, DEFAULT_BRAND_MARKUP_PCT } from '@/lib/pricing/brandMarkup'
import { buildActivationNotes } from '@/lib/quoteFeatures'

section('Brand Direct: which accounts')
eq('Brand Direct is Brand Direct', clientTypeOf('Brand Direct'), 'Brand Direct')
eq('Agency is Agency', clientTypeOf('Agency'), 'Agency')
eq('blank (most accounts) is Agency, the Salesforce default', clientTypeOf(null), 'Agency')

section('Brand Direct: the markup')
eq('starts at +10%', DEFAULT_BRAND_MARKUP_PCT, 10)
eq('10% of $12,000 media', brandMarkupAmount(12000, 10), 1200)
eq('the seller can change it', brandMarkupAmount(12000, 7.5), 900)
eq('no markup is allowed', brandMarkupAmount(12000, 0), 0)
eq('kept to 0-50%', [clampBrandMarkup(-5), clampBrandMarkup(80), clampBrandMarkup(12.25)], [0, 50, 12.3])
eq('missing or junk means the default', [clampBrandMarkup(undefined), clampBrandMarkup('abc')], [10, 10])

section('Brand Direct: shown in the Salesforce notes and counted in the total')
{
  const notes = buildActivationNotes({ baseMedia: 10000, shadowFencing: 2500, brandMarkupPct: 10, brandMarkup: 1250, transportCharge: 800 }, 'Better')
  eq('the markup line is there', notes.includes('Brand Direct +10%: $1,250'), true)
  eq('and the total includes it (10,000 + 2,500 + 1,250 + 800)', notes.includes('Total: $14,550'), true)
}

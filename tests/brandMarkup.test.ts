/**
 * Brand Direct markup — folded into every price, never shown as a line.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { brandMarkupFor, clampBrandMarkup, clientTypeOf, withMarkup, DEFAULT_BRAND_MARKUP_PCT } from '@/lib/pricing/brandMarkup'
import { computeQuote } from '@/lib/pricing/engine'
import { priceTransport } from '@/lib/pricing/transport'
import { buildActivationNotes } from '@/lib/quoteFeatures'

section('Brand Direct: which accounts, and how much')
eq('Brand Direct is Brand Direct; blank or Agency is Agency', [clientTypeOf('Brand Direct'), clientTypeOf('Agency'), clientTypeOf(null)], ['Brand Direct', 'Agency', 'Agency'])
eq('Brand Direct starts at +10%', brandMarkupFor('Brand Direct'), DEFAULT_BRAND_MARKUP_PCT)
eq('the seller can change it', brandMarkupFor('Brand Direct', 7.5), 7.5)
eq('an Agency never gets one, whatever the browser sends', brandMarkupFor('Agency', 25), 0)
eq('unknown account type: none', brandMarkupFor(null, 25), 0)
eq('kept to 0-50%', [clampBrandMarkup(-5), clampBrandMarkup(80), clampBrandMarkup(12.25)], [0, 50, 12.3])

section('Brand Direct: folded into every line item')
{
  const input = { truckCount: 2, days: 10, operatingHours: 10, marketSizeTierId: 3, includeSmartDirectional: true, includeDeviceId: true, studies: ['brand_lift' as const] }
  const plain = computeQuote(input)
  const brand = computeQuote({ ...input, markupPct: 10 })
  const ratio = (a: number, b: number) => Math.round((a / b) * 1000) / 1000
  eq('daily rate +10%', ratio(brand.dailyRate, plain.dailyRate), 1.1)
  eq('hour surcharge +10%', ratio(brand.hourSurcharge, plain.hourSurcharge), 1.1)
  eq('base media +10%', ratio(brand.good.baseMedia, plain.good.baseMedia), 1.1)
  eq('shadow fencing +10%', ratio(brand.better.shadowFencing, plain.better.shadowFencing), 1.1)
  eq('smart directional +10%', ratio(brand.better.smartDirectional, plain.better.smartDirectional), 1.1)
  eq('device ID +10%', ratio(brand.better.deviceId, plain.better.deviceId), 1.1)
  eq('study cost +10%', ratio(brand.best.studyCost, plain.best.studyCost), 1.1)
  eq('no markup means the old prices exactly', computeQuote({ ...input, markupPct: 0 }).best.total, plain.best.total)

  const legs = [{ distanceMiles: 600, needsRepositioning: true }]
  const t0 = priceTransport({ activationDays: 3, leadBusinessDays: 3, legs })
  const t1 = priceTransport({ activationDays: 3, leadBusinessDays: 3, legs, markupPct: 10 })
  eq('billed transport +10%', ratio(t1.charge, t0.charge), 1.1)
  eq('with the helper the same everywhere', withMarkup(1000, 10), 1100)
}

section('Brand Direct: invisible on the quote record')
{
  const notes = buildActivationNotes({ baseMedia: 11000, shadowFencing: 2750, transportCharge: 880 }, 'Better')
  eq('the Salesforce notes never mention it', /brand/i.test(notes), false)
  eq('the lines simply add up', notes.includes('Total: $14,630'), true)
}

section('Brand Direct: impressions follow the media buy, not the price')
{
  const input = { truckCount: 2, days: 10, marketSizeTierId: 3 }
  eq('same impressions with or without the markup', Math.round(computeQuote({ ...input, markupPct: 10 }).better.digitalImpressions), Math.round(computeQuote(input).better.digitalImpressions))
}

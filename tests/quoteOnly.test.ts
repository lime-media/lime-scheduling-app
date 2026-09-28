/**
 * "Log quote only" — a priced opportunity that reserves nothing.
 * These pin the guarantees it relies on. Run with: npm test
 */
import { eq, section } from './harness'
import { QUOTE_ONLY_STATUS, QUOTE_ONLY_ORIGINATION } from '@/lib/quoteOnly'
import { activeHoldWhere } from '@/lib/holdFilters'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs') as typeof import('fs')

section('Quote only: never blocks a truck')
{
  eq('rows are written EXPIRED', QUOTE_ONLY_STATUS, 'EXPIRED')
  const where = activeHoldWhere() as { status: { not?: string; notIn?: string[] } }
  eq('every availability / conflict / quoting query drops EXPIRED rows', where.status.not === 'EXPIRED' || (where.status.notIn ?? []).includes('EXPIRED'), true)
  eq('its origination marks it on the Holds page', QUOTE_ONLY_ORIGINATION, 'quote_only')
}

section('Quote only: the hourly sweep and reconcile leave it alone')
{
  const cache = fs.readFileSync('lib/scheduleCache.ts', 'utf8')
  eq('expiry only looks at HOLD / EXTENSION_REQUESTED', /status:\s*\{\s*in:\s*\['HOLD',\s*'EXTENSION_REQUESTED'\]\s*\}/.test(cache), true)
  const reconcile = fs.readFileSync('lib/sfdcOpportunityReconcile.ts', 'utf8')
  eq('reconcile only looks at HOLD / EXTENSION_REQUESTED', /RECONCILABLE_STATUSES = \['HOLD', 'EXTENSION_REQUESTED'\]/.test(reconcile), true)
}

section('Quote only: the opportunity carries no LED truck or hold fields')
{
  // Salesforce turns those fields into reservations (the hold webhook), so a
  // quote-only opportunity must leave them empty in both booking routes.
  for (const route of ['app/api/quote/hold/route.ts', 'app/api/plan/hold/route.ts']) {
    const src = fs.readFileSync(route, 'utf8')
    eq(`${route}: truck and hold fields are skipped for quote-only`, /\.\.\.\(quoteOnly[^?]*\?\s*\{\}\s*:\s*\{[\s\S]*?truckNumbers[\s\S]*?\}\)/.test(src), true)
  }
}

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

section('Quote only: review fixes')
{
  const plan = fs.readFileSync('app/api/plan/hold/route.ts', 'utf8')
  eq('a real booking never matches a quote-only log (separate id spaces)', plan.includes("`${quoteOnly ? QUOTE_ONLY_GROUP_PREFIX : 'mm_'}${body.requestId}_`"), true)
  eq('one quote-only record per market, including markets no truck covers', /quoteOnlyRows[^=]*=\s*quote\.lines\.map/.test(plan) && plan.includes('QUOTE_ONLY_NO_TRUCK'), true)
  eq('quote-only records are not linked to the client portal (multi)', /quoteOnlyRows[\s\S]*?client_user_id: null/.test(plan), true)
  const single = fs.readFileSync('app/api/quote/hold/route.ts', 'utf8')
  eq('single-market: "no trucks available" does not block a quote-only log', single.includes('if (selectedTrucks.length === 0 && !quoteOnly)'), true)
  eq('quote-only records are not linked to the client portal (single)', single.includes('client_user_id:    quoteOnly ? null'), true)
  const client = fs.readFileSync('app/api/client/hold-requests/route.ts', 'utf8')
  eq('the client portal list excludes quote-only logs', client.includes('NOT: { origination: QUOTE_ONLY_ORIGINATION }'), true)
  const planner = fs.readFileSync('components/PlannerTab.tsx', 'utf8')
  eq('switching quote-only on/off starts a new booking attempt', planner.includes('useEffect(() => { bookingId.current = newBookingId(); setHoldResult(null) }, [quoteOnly])'), true)
}

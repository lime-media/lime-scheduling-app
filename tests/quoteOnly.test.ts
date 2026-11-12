/**
 * "Log quote only" — a priced opportunity that reserves nothing.
 * These pin the guarantees it relies on. Run with: npm test
 */
import { eq, section } from './harness'
import { QUOTE_ONLY_STATUS, QUOTE_ONLY_ORIGINATION, listedQuotes, type QuoteListRow } from '@/lib/quoteOnly'
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
  // Quote-only rows are EXPIRED from the start, so the reconcile must never read
  // EXPIRED rows (it also reads COMMITTED since #120: committed means Closed Won).
  const reconcilable = /RECONCILABLE_STATUSES = \[([^\]]*)\]/.exec(reconcile)?.[1] ?? ''
  eq('reconcile never looks at EXPIRED (quote-only) rows', reconcilable.length > 0 && !reconcilable.includes('EXPIRED'), true)
}

section('Quote only: the opportunity carries no LED truck or hold fields')
{
  // Salesforce turns those fields into reservations (the hold webhook), so a
  // quote-only opportunity must leave them empty in both booking routes.
  for (const route of ['lib/staffBooking.ts', 'app/api/plan/hold/route.ts']) {
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
  const single = fs.readFileSync('lib/staffBooking.ts', 'utf8')
  eq('single-market: "no trucks available" does not block a quote-only log', single.includes('if (selectedTrucks.length === 0 && !quoteOnly)'), true)
  eq('quote-only records are not linked to the client portal (single)', single.includes('client_user_id:    quoteOnly ? null'), true)
  const client = fs.readFileSync('app/api/client/hold-requests/route.ts', 'utf8')
  eq('the client portal list excludes quote-only logs', client.includes('NOT: { origination: QUOTE_ONLY_ORIGINATION }'), true)
  const planner = fs.readFileSync('components/PlannerTab.tsx', 'utf8')
  eq('switching quote-only on/off starts a new booking attempt', planner.includes('useEffect(() => { bookingId.current = newBookingId(); setHoldResult(null) }, [quoteOnly])'), true)
}

section('Quote only: cannot be reinstated into a live hold')
{
  const route = fs.readFileSync('app/api/hold-requests/[id]/route.ts', 'utf8')
  const reinstate = route.slice(route.indexOf("if (action === 'reinstate')"))
  eq('the reinstate action refuses quote-only logs first', reinstate.indexOf('QUOTE_ONLY_ORIGINATION') > -1 && reinstate.indexOf('QUOTE_ONLY_ORIGINATION') < reinstate.indexOf("status: 'HOLD'"), true)
}

section('Single-market booking: the price shown is the price booked')
{
  const route = fs.readFileSync('lib/staffBooking.ts', 'utf8')
  eq('the server refuses a total the rep did not see', /Math\.abs\(serverTotal - expected_total\) >= 1/.test(route), true)
  const page = fs.readFileSync('app/quote/page.tsx', 'utf8')
  eq('the page sends the total it shows', page.includes('expected_total: expectedOverride ?? shownTotal()'), true)
  eq('booking waits while a markup change is not re-priced', page.includes('markupPending ||'), true)
}

section('quote-only: which quotes Reservations lists under Quotes')
{
  const q = (key: string, opp: string | null, start: string, created: string) =>
    ({ key, origination: QUOTE_ONLY_ORIGINATION, status: 'EXPIRED', sfdc_opportunity_id: opp, start_date: start, created_at: created })
  const live = (key: string, opp: string, status = 'HOLD') =>
    ({ key, origination: 'frontend', status, sfdc_opportunity_id: opp, start_date: '2026-12-01', created_at: '2026-11-01T00:00:00Z' })
  const keyOf = (r: { key: string }) => r.key
  const today = '2026-11-11'
  const list = (rows: (QuoteListRow & { key: string })[]) => [...listedQuotes(rows, keyOf, today)].sort()

  eq('a quote still to start is listed', list([q('a', 'opp1', '2026-12-01', '2026-11-10T10:00:00Z')]), ['a'])
  eq('a quote starting today is still listed', list([q('a', 'opp1', today, '2026-11-10T10:00:00Z')]), ['a'])
  eq('a quote whose start has passed drops off', list([q('a', 'opp1', '2026-11-10', '2026-11-01T10:00:00Z')]), [])
  eq('a multi-market quote drops off when its FIRST market starts', list([
    q('m', 'opp1', '2026-11-10', '2026-11-01T10:00:00Z'), q('m', 'opp1', '2026-12-01', '2026-11-01T10:00:00Z'),
  ]), [])
  eq('a later quote of the same opportunity supersedes the earlier', list([
    q('old', 'opp1', '2026-12-01', '2026-11-01T10:00:00Z'), q('new', 'opp1', '2026-12-05', '2026-11-05T10:00:00Z'),
  ]), ['new'])
  eq('quotes of different opportunities both list', list([
    q('a', 'opp1', '2026-12-01', '2026-11-01T10:00:00Z'), q('b', 'opp2', '2026-12-01', '2026-11-01T10:00:00Z'),
  ]), ['a', 'b'])
  eq('a quote with no opportunity stands alone', list([
    q('a', null, '2026-12-01', '2026-11-01T10:00:00Z'), q('b', null, '2026-12-01', '2026-11-02T10:00:00Z'),
  ]), ['a', 'b'])
  eq('a reserved opportunity takes its quote off the list', list([
    q('a', 'opp1', '2026-12-01', '2026-11-01T10:00:00Z'), live('h', 'opp1'),
  ]), [])
  eq('a won (committed) opportunity takes it off too', list([
    q('a', 'opp1', '2026-12-01', '2026-11-01T10:00:00Z'), live('h', 'opp1', 'COMMITTED'),
  ]), [])
  eq('an expired reservation of the opportunity does not', list([
    q('a', 'opp1', '2026-12-01', '2026-11-01T10:00:00Z'), live('h', 'opp1', 'EXPIRED'),
  ]), ['a'])
  eq('a superseded quote whose successor passed its start is not brought back', list([
    q('old', 'opp1', '2026-12-01', '2026-11-01T10:00:00Z'), q('new', 'opp1', '2026-11-10', '2026-11-05T10:00:00Z'),
  ]), [])
  eq('equal log times pick one, stably', list([
    q('a', 'opp1', '2026-12-01', '2026-11-01T10:00:00Z'), q('b', 'opp1', '2026-12-01', '2026-11-01T10:00:00Z'),
  ]), ['b'])
}

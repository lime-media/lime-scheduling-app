/**
 * Transport and deal-value metrics (lib/transportMetrics.ts): how each truck's
 * transport is classified and costed, which holds get an EXECUTED record, and
 * the KPIs /ops/transport shows.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { absorbedLegCost } from '@/lib/pricing/transport'
import {
  activationDaysOf, churnKpis, dealDrift, executedCandidates, executedOrigin, leadBusinessDays, legCost, legFromInbound, legOutcome,
  legsFromArrivals, legsFromSelectedTrucks, plannedVsActual, prestartCandidates, quotedPlan, transportKpis, type DealRow, type LegRow,
  type MeasuredLeg,
} from '@/lib/transportMetrics'

section('transport metrics: each truck is local, absorbed or billed')
eq('inside the service area: local', legOutcome(false, 0), 'LOCAL')
eq('repositions and the client pays: billed', legOutcome(true, 1100), 'BILLED')
eq('repositions and we pay: absorbed', legOutcome(true, 0), 'ABSORBED')
eq('our cost of a local truck: nothing', legCost(false, 0), 0)
eq('our cost of a 2-day move, billed or not', legCost(true, 2), Math.round(absorbedLegCost(2) * 100) / 100)

section('transport metrics: legs from the single-market quote')
{
  const truck = (n: string, miles: number, needed: boolean, days: number, priorJob = true) => ({
    truckNumber: n, distanceMiles: miles, transport: { needed, transportDays: days },
    chain: { inbound: { originLabel: priorJob ? 'Dallas, TX' : 'current position', originIsPriorJob: priorJob, originResolved: true } },
  })
  const legs = legsFromSelectedTrucks([truck('0820', 12.4, false, 0), truck('1867', 1349, true, 3, false)],
    { outcome: 'BILLED', legs: [{ truckNumber: '1867', charge: 3100 }] })
  eq('local truck: no charge, prior job', [legs[0].repositions, legs[0].charge, legs[0].originKind, legs[0].miles], [false, 0, 'PRIOR_JOB', 12])
  eq('repositioning truck: its own charge, GPS origin', [legs[1].repositions, legs[1].charge, legs[1].originKind, legs[1].transportDays], [true, 3100, 'GPS', 3])
  const absorbed = legsFromSelectedTrucks([truck('1867', 1349, true, 3)], { outcome: 'ABSORBED', legs: [{ truckNumber: '1867', charge: 0 }] })
  eq('absorbed booking: no charge', absorbed[0].charge, 0)
}

section('transport metrics: legs from a multi-market market')
{
  const legs = legsFromArrivals([
    { truckNumber: '0673', from: 'Dallas', fromKind: 'PRIOR_JOB', miles: 864.4, transportDays: 2, outOfMarket: true, charge: 2100 },
    { truckNumber: '0794', from: 'Fargo, ND', fromKind: 'THIS_ORDER', miles: 87, transportDays: 0, outOfMarket: false, charge: 0 },
    { truckNumber: '0937', from: 'Minneapolis', fromKind: 'SHARED', miles: 40, transportDays: 0, outOfMarket: false, charge: 0 },
  ])
  eq('out of market: repositions, charged', [legs[0].repositions, legs[0].charge, legs[0].miles], [true, 2100, 864])
  eq('from earlier in the order or a shared truck: same order, local', [legs[1].originKind, legs[2].originKind, legs[1].repositions], ['SAME_ORDER', 'SAME_ORDER', false])
}

section('transport metrics: a measured way in (swap, executed)')
{
  const inbound = { originLabel: 'St George, UT', originIsPriorJob: false, originResolved: true, distanceMiles: 488, transportDays: 2 }
  const leg = legFromInbound('1002', inbound, 250, 0)
  eq('GPS origin beyond the area: repositions, the slot\'s charge carries over', [leg.originKind, leg.repositions, leg.charge, leg.miles], ['GPS', true, 0, 488])
  eq('unpriced: absorbed', legOutcome(leg.repositions, leg.charge), 'ABSORBED')
  const unknown = legFromInbound('1002', { ...inbound, originResolved: false }, 250, 1100)
  eq('origin unknown: no miles, not counted as repositioning', [unknown.originKind, unknown.miles, unknown.repositions], ['UNKNOWN', null, false])
}

section('transport metrics: lead time and activation days')
eq('weekdays strictly between (Mon Oct 19 → Tue Nov 3)', leadBusinessDays(new Date('2026-10-19T15:00:00Z'), new Date('2026-11-03T00:00:00Z')), 10)
eq('activation days from the quote features', activationDaysOf(JSON.stringify({ activationDays: 20 })), 20)
eq('no features: null', activationDaysOf(null), null)
eq('bad JSON: null', activationDaysOf('{'), null)

section('transport metrics: which holds get an EXECUTED record')
{
  const h = (id: string, start: string, status = 'HOLD', origination = 'frontend') => ({ id, status, origination, start_date: new Date(start + 'T00:00:00Z') })
  const holds = [h('a', '2026-10-20'), h('b', '2026-10-17'), h('c', '2026-10-16'), h('d', '2026-10-21'), h('e', '2026-10-20', 'EXPIRED'),
    h('f', '2026-10-20', 'COMMITTED'), h('g', '2026-10-20', 'HOLD', 'quote_only'), h('i', '2026-10-19', 'ATT_SOFT')]
  eq('started today or in the last 3 days, live, not yet recorded', executedCandidates(holds, new Set(['f']), '2026-10-20').map(x => x.id), ['a', 'b'])
}

section('transport metrics: KPIs')
{
  const at = (m: number) => new Date(Date.UTC(2026, 9, 20, 12, m))
  const leg = (o: Partial<LegRow>): LegRow => ({ event: 'BOOKED', hold_id: 'h1', booking_key: 'b1', client_name: 'Acme', market: 'Dallas, TX', truck_number: '0820', miles: 10, outcome: 'LOCAL', charge: 0, est_cost: 0, created_at: at(0), ...o })
  const legs: LegRow[] = [
    leg({}),
    leg({ hold_id: 'h2', truck_number: '1867', miles: 900, outcome: 'BILLED', charge: 2100, est_cost: 1712.5 }),
    leg({ hold_id: 'h3', booking_key: 'b2', client_name: 'Beta', market: 'Boston, MA', truck_number: '9972', miles: 1200, outcome: 'ABSORBED', est_cost: 2478.75 }),
    // h1 swapped to a truck that comes from far away, then it ran from there.
    leg({ event: 'SWAPPED', truck_number: '1002', miles: 488, outcome: 'ABSORBED', est_cost: 1712.5, created_at: at(5) }),
    leg({ event: 'EXECUTED', truck_number: '1002', miles: 488, outcome: 'ABSORBED', est_cost: 1712.5, created_at: at(9) }),
    leg({ event: 'EXECUTED', hold_id: 'h2', truck_number: '1867', miles: 900, outcome: 'BILLED', charge: 2100, est_cost: 1712.5, created_at: at(9) }),
  ]
  const t = transportKpis(legs)
  eq('the latest plan per hold', [t.trucks, t.local, t.absorbed, t.billed], [3, 0, 2, 1])
  eq('charged vs our cost', [t.charged, t.cost, t.absorbedCost], [2100, 5903.75, 4191.25])
  eq('by client, biggest cost first', t.byClient.map(x => x.name), ['Acme', 'Beta'])

  const p = plannedVsActual(legs)
  eq('compared against the latest plan (the swap)', [p.compared, p.truckChangedPct, p.outcomeChangedPct], [2, 0, 0])
  const quotedLocal = plannedVsActual([leg({}), leg({ event: 'EXECUTED', truck_number: '1002', miles: 488, outcome: 'ABSORBED', est_cost: 1712.5, created_at: at(9) })])
  eq('quoted local, ran from outside the area: unpriced repositioning', [quotedLocal.unpricedRepositioning, quotedLocal.unpricedCost, quotedLocal.truckChangedPct], [1, 1712.5, 100])

  const ch = churnKpis([...legs,
    leg({ event: 'REVISED', hold_id: 'h4', booking_key: 'b2', created_at: at(20) }), leg({ event: 'REVISED', hold_id: 'h5', booking_key: 'b2', created_at: at(20) })])
  eq('a revision counts once per booking, swaps per truck', [ch.bookings, ch.swaps, ch.revisions, ch.changedPct], [2, 1, 1, 100])
}

section('transport metrics: quote vs Salesforce contract')
{
  const at = (d: number) => new Date(Date.UTC(2026, 9, d))
  const row = (o: Partial<DealRow>): DealRow => ({ event: 'BOOKED', sfdc_opportunity_id: '006A', booking_key: 'b1', client_name: 'Acme', app_quoted_total: null, sf_amount: null, captured_at: at(1), ...o })
  const d = dealDrift([
    row({ app_quoted_total: 40000 }),
    row({ event: 'REVISED', app_quoted_total: 45000, captured_at: at(3) }),
    row({ booking_key: 'b2', app_quoted_total: 5000, captured_at: at(4) }),
    row({ event: 'WON', booking_key: null, sf_amount: 48000, captured_at: at(10) }),
    row({ event: 'AMOUNT_CHANGED', booking_key: null, sf_amount: 47000, captured_at: at(15) }),
    // Not won: left out.
    row({ sfdc_opportunity_id: '006B', app_quoted_total: 9000 }),
  ])
  eq('one won deal: latest quote per booking summed, against the latest Amount', [d.wonDeals, d.quoted, d.contract, d.drift, d.driftPct], [1, 50000, 47000, -3000, -6])
  eq('the deal keeps its Amount at won', [d.biggest[0].wonAmount, d.biggest[0].currentAmount], [48000, 47000])
}

section('transport metrics: the pre-start snapshot (local review, pass 1 decisions)')
{
  const h = (id: string, start: string, status = 'HOLD', origination = 'frontend') => ({ id, status, origination, start_date: new Date(start + 'T00:00:00Z') })
  const holds = [h('a', '2026-10-21'), h('b', '2026-10-23'), h('c', '2026-10-24'), h('d', '2026-10-20'), h('e', '2026-10-22', 'EXPIRED'),
    h('f', '2026-10-22', 'COMMITTED'), h('g', '2026-10-22', 'HOLD', 'quote_only'), h('i', '2026-10-22')]
  eq('starts in the next 3 days (not today), live, not yet snapped', prestartCandidates(holds, new Set(['i']), '2026-10-20').map(x => x.id), ['a', 'b', 'f'])

  const gps: MeasuredLeg = { truckNumber: '1867', originLabel: 'current position', originKind: 'GPS', miles: 4, transportDays: 0, repositions: false, charge: 0 }
  const snap = { truck_number: '1867', origin_label: 'current position', origin_kind: 'GPS', miles: 900, transport_days: 2 }
  // On the first day the truck already sits in market: the snapshot taken
  // before it moved shows the 900-mile drive in.
  const e = executedOrigin(gps, snap, 250)
  eq('no prior job: the pre-start snapshot (same truck)', [e.miles, e.repositions, e.transportDays, e.originKind], [900, true, 2, 'GPS'])
  eq('a prior job is measured as is', executedOrigin({ ...gps, originKind: 'PRIOR_JOB', miles: 300, repositions: true, transportDays: 1 }, snap, 250).miles, 300)
  eq('a different truck ran it: the snapshot was of another truck, so GPS', executedOrigin({ ...gps, truckNumber: '1002' }, snap, 250).miles, 4)
  eq('no snapshot: GPS', executedOrigin(gps, null, 250).miles, 4)
  eq('the client still pays the slot\'s quoted charge', executedOrigin({ ...gps, charge: 2100 }, snap, 250).charge, 2100)
}

section('transport metrics: quoted transport counts everything quoted')
{
  const at = (m: number) => new Date(Date.UTC(2026, 9, 20, 12, m))
  const leg = (o: Partial<LegRow>): LegRow => ({ event: 'BOOKED', hold_id: 'h1', booking_key: 'b1', client_name: 'Acme', market: 'Dallas, TX', truck_number: '0820', miles: 10, outcome: 'LOCAL', charge: 0, est_cost: 0, created_at: at(0), ...o })
  const legs: LegRow[] = [
    // b1: booked with 2 trucks, then revised to 3 (new holds), then one swapped.
    leg({}), leg({ hold_id: 'h2', truck_number: '1867' }),
    leg({ event: 'REVISED', hold_id: 'h3', created_at: at(10) }), leg({ event: 'REVISED', hold_id: 'h4', truck_number: '1867', created_at: at(10) }),
    leg({ event: 'REVISED', hold_id: 'h5', truck_number: '9972', miles: 1200, outcome: 'ABSORBED', est_cost: 2478.75, created_at: at(10) }),
    leg({ event: 'SWAPPED', hold_id: 'h4', truck_number: '1002', miles: 488, outcome: 'ABSORBED', est_cost: 1712.5, created_at: at(15) }),
    // b2: cancelled (its holds are gone), still quoted.
    leg({ hold_id: 'h9', booking_key: 'b2', client_name: 'Beta', truck_number: '7423', miles: 900, outcome: 'BILLED', charge: 2100, est_cost: 1712.5 }),
    // Snapshots and outcomes are never part of the plan.
    leg({ event: 'PRESTART', hold_id: 'h3', miles: 700, outcome: 'ABSORBED', est_cost: 1712.5, created_at: at(20) }),
    leg({ event: 'EXECUTED', hold_id: 'h3', miles: 700, outcome: 'ABSORBED', est_cost: 1712.5, created_at: at(30) }),
  ]
  const plan = quotedPlan(legs)
  eq('one leg per truck slot: the latest revision, swaps applied, plus the cancelled booking', plan.map(l => `${l.hold_id}:${l.truck_number}`).sort(), ['h3:0820', 'h4:1002', 'h5:9972', 'h9:7423'])
  const t = transportKpis(legs)
  eq('quoted KPIs include the cancelled booking', [t.trucks, t.local, t.absorbed, t.billed, t.charged], [4, 1, 2, 1, 2100])
  eq('PRESTART is in no churn figure', churnKpis(legs).swaps, 1)
}

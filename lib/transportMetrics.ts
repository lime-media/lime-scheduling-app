/**
 * Transport and deal-value metrics: the pure half. What a booking quoted for
 * each truck's transport (local, absorbed or billed; miles, travel days, what
 * we charge and what it costs us), how that changes as the booking is edited,
 * what actually happened on the campaign's first day, and how the app's quoted
 * total compares with Salesforce's Amount once the deal is won.
 *
 * Rows are written by lib/transportMetricsRecord.ts into app_transport_legs and
 * app_deal_values; /ops/transport reads them through the KPI functions below.
 * Pure (no database), so `npm test` can load it.
 */

import { absorbedLegCost, needsRepositioning } from '@/lib/pricing/transport'

export type LegEvent = 'BOOKED' | 'SWAPPED' | 'REVISED' | 'EXECUTED' | 'PRESTART'

/**
 * The legs that make up a booking's plan. EXECUTED is what happened; PRESTART
 * is only a snapshot of where the truck sat before it moved (the source of
 * EXECUTED's origin), never a plan or an outcome in any KPI.
 */
export const PLAN_EVENTS: ReadonlySet<string> = new Set(['BOOKED', 'SWAPPED', 'REVISED'])
export type OriginKind = 'PRIOR_JOB' | 'GPS' | 'SAME_ORDER' | 'UNKNOWN'
export type LegOutcome = 'LOCAL' | 'ABSORBED' | 'BILLED'
export type DealEvent = 'BOOKED' | 'REVISED' | 'WON' | 'AMOUNT_CHANGED'

/** One truck's way to a campaign, as quoted or as measured. */
export type MeasuredLeg = {
  truckNumber: string
  originLabel: string
  originKind: OriginKind
  miles: number | null
  transportDays: number
  /** Beyond the service area: the truck has to reposition. */
  repositions: boolean
  /** What the client pays for this truck's transport (0 unless billed). */
  charge: number
}

/** Local inside the service area; else billed when the client pays for it, absorbed when we do. */
export function legOutcome(repositions: boolean, charge: number): LegOutcome {
  if (!repositions) return 'LOCAL'
  return charge > 0 ? 'BILLED' : 'ABSORBED'
}

/** What a move costs us, billed or not: zero inside the service area. */
export function legCost(repositions: boolean, transportDays: number): number {
  return repositions ? Math.round(absorbedLegCost(Math.max(1, transportDays)) * 100) / 100 : 0
}

/** The single-market quote's trucks (lib/availabilityEngine.ts AvailableTruck) as legs, with the charge priceTransport gave each. */
export function legsFromSelectedTrucks(
  trucks: { truckNumber: string; distanceMiles: number; transport: { needed: boolean; transportDays: number }; chain: { inbound: { originLabel: string; originIsPriorJob: boolean; originResolved: boolean } } }[],
  transport: { outcome: string; legs: { truckNumber?: string; charge: number }[] },
): MeasuredLeg[] {
  return trucks.map(t => {
    const charge = transport.outcome === 'BILLED' ? transport.legs.find(l => l.truckNumber === t.truckNumber)?.charge ?? 0 : 0
    return {
      truckNumber: t.truckNumber,
      originLabel: t.chain.inbound.originLabel,
      originKind: t.chain.inbound.originIsPriorJob ? 'PRIOR_JOB' : t.chain.inbound.originResolved ? 'GPS' : 'UNKNOWN',
      miles: Math.round(t.distanceMiles),
      transportDays: t.transport.needed ? t.transport.transportDays : 0,
      repositions: t.transport.needed,
      charge,
    }
  })
}

/** A multi-market market's arrivals (lib/planning/quote.ts Arrival) as legs. */
export function legsFromArrivals(
  arrivals: { truckNumber: string; from: string; fromKind: string; miles: number; transportDays: number; outOfMarket: boolean; charge: number }[],
): MeasuredLeg[] {
  return arrivals.map(a => ({
    truckNumber: a.truckNumber,
    originLabel: a.from,
    originKind: a.fromKind === 'PRIOR_JOB' ? 'PRIOR_JOB' : a.fromKind === 'GPS' ? 'GPS' : 'SAME_ORDER',
    miles: Math.round(a.miles),
    transportDays: a.outOfMarket ? a.transportDays : 0,
    repositions: a.outOfMarket,
    charge: a.outOfMarket ? a.charge : 0,
  }))
}

/**
 * A measured way in (lib/chainFeasibility.ts InboundLeg) for a truck that was
 * swapped onto a booking or that ran it. The client pays what was quoted for
 * the slot, whatever truck runs it, so `plannedCharge` carries over.
 */
export function legFromInbound(
  truckNumber: string,
  inbound: { originLabel: string; originIsPriorJob: boolean; originResolved: boolean; distanceMiles: number; transportDays: number },
  serviceAreaMiles: number,
  plannedCharge: number,
): MeasuredLeg {
  const repositions = inbound.originResolved && needsRepositioning(inbound.distanceMiles, serviceAreaMiles)
  return {
    truckNumber,
    originLabel: inbound.originResolved ? inbound.originLabel : '',
    originKind: !inbound.originResolved ? 'UNKNOWN' : inbound.originIsPriorJob ? 'PRIOR_JOB' : 'GPS',
    miles: inbound.originResolved ? Math.round(inbound.distanceMiles) : null,
    transportDays: repositions ? inbound.transportDays : 0,
    repositions,
    charge: plannedCharge,
  }
}

/** Weekdays strictly between two dates, as lib/pricing/resolvers.ts businessDaysBetween counts lead time. */
export function leadBusinessDays(from: Date, to: Date): number {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())
  let n = 0
  for (d.setUTCDate(d.getUTCDate() + 1); d.getTime() < end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n++
  }
  return n
}

/** Billed activation days a hold's quote recorded (features JSON), or null. */
export function activationDaysOf(features: string | null): number | null {
  if (!features) return null
  try {
    const n = (JSON.parse(features) as { activationDays?: unknown }).activationDays
    return typeof n === 'number' && Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/**
 * Holds whose first day has come and that have no EXECUTED record yet: the
 * sweep measures what actually ran them. Reservations (HOLD) and committed
 * bookings only, starting today or in the last `lookbackDays` (so a missed
 * sweep still catches them), never quote-only logs or AT&T soft holds. Pure.
 */
export function executedCandidates<T extends { id: string; status: string; origination: string; start_date: Date }>(
  holds: T[], executedHoldIds: Set<string>, today: string, lookbackDays = 3,
): T[] {
  const earliest = new Date(today + 'T00:00:00Z')
  earliest.setUTCDate(earliest.getUTCDate() - lookbackDays)
  const from = earliest.toISOString().slice(0, 10)
  return holds.filter(h => {
    const start = h.start_date.toISOString().slice(0, 10)
    return (h.status === 'HOLD' || h.status === 'COMMITTED')
      && h.origination !== 'quote_only'
      && start >= from && start <= today
      && !executedHoldIds.has(h.id)
  })
}

/**
 * Holds starting in the next `daysAhead` days (not today) with no PRESTART
 * snapshot yet: the sweep records where their truck sits now, before it moves,
 * so the EXECUTED record on the first day can measure the real way in. Same
 * holds as executedCandidates otherwise. Pure.
 */
export function prestartCandidates<T extends { id: string; status: string; origination: string; start_date: Date }>(
  holds: T[], prestartHoldIds: Set<string>, today: string, daysAhead = 3,
): T[] {
  const latest = new Date(today + 'T00:00:00Z')
  latest.setUTCDate(latest.getUTCDate() + daysAhead)
  const until = latest.toISOString().slice(0, 10)
  return holds.filter(h => {
    const start = h.start_date.toISOString().slice(0, 10)
    return (h.status === 'HOLD' || h.status === 'COMMITTED')
      && h.origination !== 'quote_only'
      && start > today && start <= until
      && !prestartHoldIds.has(h.id)
  })
}

/**
 * Where the truck that ran a hold came from, as recorded on its first day. On
 * that day a truck with no prior job usually already sits in the market, so
 * its GPS reads as local even after a long drive in. Order: the truck's last
 * job before the start (measured now); else the hold's PRESTART snapshot,
 * taken before it moved, if it was the same truck; else the GPS reading as
 * measured. The client still pays what was quoted for the slot. Pure.
 */
export function executedOrigin(
  measured: MeasuredLeg,
  prestart: { truck_number: string; origin_label: string; origin_kind: string; miles: number | null; transport_days: number } | null,
  serviceAreaMiles: number,
): MeasuredLeg {
  if (measured.originKind === 'PRIOR_JOB' || !prestart || prestart.truck_number !== measured.truckNumber) return measured
  const repositions = prestart.miles != null && needsRepositioning(prestart.miles, serviceAreaMiles)
  const kind = prestart.origin_kind
  return {
    truckNumber: measured.truckNumber,
    originLabel: prestart.origin_label,
    originKind: kind === 'PRIOR_JOB' || kind === 'GPS' || kind === 'SAME_ORDER' ? kind : 'UNKNOWN',
    miles: prestart.miles,
    transportDays: repositions ? Math.max(1, prestart.transport_days) : 0,
    repositions,
    charge: measured.charge,
  }
}

// ── KPIs (/ops/transport) ───────────────────────────────────────────────────

export type LegRow = {
  event: string; hold_id: string | null; booking_key: string | null; client_name: string; market: string
  truck_number: string; miles: number | null; outcome: string; charge: number; est_cost: number; created_at: Date
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0)
const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100

/** The plan as it stands: each hold's latest BOOKED / SWAPPED / REVISED leg. */
export function latestPlanned(legs: LegRow[]): Map<string, LegRow> {
  const out = new Map<string, LegRow>()
  for (const l of legs) {
    if (!PLAN_EVENTS.has(l.event) || !l.hold_id) continue
    const was = out.get(l.hold_id)
    if (!was || l.created_at > was.created_at) out.set(l.hold_id, l)
  }
  return out
}

type Split = { trucks: number; local: number; absorbed: number; billed: number; charged: number; cost: number; absorbedCost: number }
const split = (rows: LegRow[]): Split => ({
  trucks: rows.length,
  local: rows.filter(r => r.outcome === 'LOCAL').length,
  absorbed: rows.filter(r => r.outcome === 'ABSORBED').length,
  billed: rows.filter(r => r.outcome === 'BILLED').length,
  charged: sum(rows.map(r => r.charge)),
  cost: sum(rows.map(r => r.est_cost)),
  absorbedCost: sum(rows.filter(r => r.outcome === 'ABSORBED').map(r => r.est_cost)),
})

/**
 * Everything quoted, one leg per truck slot, cancelled bookings included: per
 * booking, the latest generation of its plan (its latest revision's REVISED
 * legs, else its BOOKED legs), each slot updated by any later swap onto that
 * hold. Whether the holds still exist doesn't matter: a cancelled booking was
 * still quoted. Legs with no booking key count per hold. Pure.
 */
export function quotedPlan(legs: LegRow[]): LegRow[] {
  const plan = legs.filter(l => PLAN_EVENTS.has(l.event))
  const byBooking = new Map<string, LegRow[]>()
  const loose: LegRow[] = []
  for (const l of plan) {
    if (l.booking_key) byBooking.set(l.booking_key, [...(byBooking.get(l.booking_key) ?? []), l])
    else loose.push(l)
  }
  const out: LegRow[] = []
  // A revision writes one row per truck at one moment.
  const minute = (l: LegRow) => Math.floor(l.created_at.getTime() / 60_000)
  for (const rows of byBooking.values()) {
    const revisions = rows.filter(l => l.event === 'REVISED')
    const lastRevision = revisions.length ? Math.max(...revisions.map(minute)) : null
    const base = lastRevision != null ? revisions.filter(l => minute(l) === lastRevision) : rows.filter(l => l.event === 'BOOKED')
    for (const b of base) {
      const later = rows.filter(l => l.event === 'SWAPPED' && l.hold_id && l.hold_id === b.hold_id && l.created_at > b.created_at)
      out.push(later.reduce((a, l) => (l.created_at > a.created_at ? l : a), b))
    }
  }
  return [...out, ...latestPlanned(loose).values()]
}

/** Quoted transport: everything quoted (quotedPlan), as counts, $ charged and our estimated cost, overall and by client and market (top 10 by cost). */
export function transportKpis(legs: LegRow[]) {
  const plan = quotedPlan(legs)
  const top = (key: (r: LegRow) => string) => {
    const by = new Map<string, LegRow[]>()
    for (const r of plan) by.set(key(r), [...(by.get(key(r)) ?? []), r])
    return [...by].map(([name, rows]) => ({ name, ...split(rows) })).sort((a, b) => b.cost - a.cost || b.trucks - a.trucks).slice(0, 10)
  }
  const all = split(plan)
  return {
    ...all,
    localPct: pct(all.local, all.trucks), absorbedPct: pct(all.absorbed, all.trucks), billedPct: pct(all.billed, all.trucks),
    byClient: top(r => r.client_name || 'Unknown'),
    byMarket: top(r => r.market || 'Unknown'),
  }
}

/**
 * Planned vs actual, for holds with both a plan and an EXECUTED record: quoted
 * vs actual miles, how often the outcome differed, and repositioning that was
 * never priced (executed out of area where the plan said local).
 */
export function plannedVsActual(legs: LegRow[]) {
  const plan = latestPlanned(legs)
  const pairs = legs
    .filter(l => l.event === 'EXECUTED' && l.hold_id && plan.has(l.hold_id))
    .map(e => ({ planned: plan.get(e.hold_id!)!, executed: e }))
  const withMiles = pairs.filter(p => p.planned.miles != null && p.executed.miles != null)
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0)
  const unpriced = pairs.filter(p => p.planned.outcome === 'LOCAL' && p.executed.outcome !== 'LOCAL')
  return {
    compared: pairs.length,
    avgQuotedMiles: avg(withMiles.map(p => p.planned.miles!)),
    avgActualMiles: avg(withMiles.map(p => p.executed.miles!)),
    truckChangedPct: pct(pairs.filter(p => p.planned.truck_number !== p.executed.truck_number).length, pairs.length),
    outcomeChangedPct: pct(pairs.filter(p => p.planned.outcome !== p.executed.outcome).length, pairs.length),
    unpricedRepositioning: unpriced.length,
    unpricedCost: sum(unpriced.map(p => p.executed.est_cost)),
  }
}

/** Churn: how many bookings were changed after booking (swaps, revisions), and how often. */
export function churnKpis(legs: LegRow[]) {
  const byBooking = new Map<string, { swaps: number; revisions: Set<number> }>()
  for (const l of legs) {
    if (!l.booking_key || !PLAN_EVENTS.has(l.event)) continue
    const b = byBooking.get(l.booking_key) ?? { swaps: 0, revisions: new Set<number>() }
    if (l.event === 'SWAPPED') b.swaps++
    // A revision writes one row per truck at one moment: count it once.
    if (l.event === 'REVISED') b.revisions.add(Math.floor(l.created_at.getTime() / 60_000))
    byBooking.set(l.booking_key, b)
  }
  const bookings = [...byBooking.values()]
  const changes = bookings.map(b => b.swaps + b.revisions.size)
  return {
    bookings: bookings.length,
    changedPct: pct(changes.filter(c => c > 0).length, bookings.length),
    swaps: sum(bookings.map(b => b.swaps)),
    revisions: sum(bookings.map(b => b.revisions.size)),
    changesPerBooking: bookings.length ? Math.round((sum(changes) / bookings.length) * 100) / 100 : 0,
  }
}

export type DealRow = {
  event: string; sfdc_opportunity_id: string | null; booking_key: string | null; client_name: string
  app_quoted_total: number | null; sf_amount: number | null; captured_at: Date
}

/**
 * Deal value drift, per won opportunity: the app's quoted total (the latest
 * BOOKED / REVISED figure of each booking on it, summed) against Salesforce's
 * Amount at Closed Won and its latest Amount since. Biggest gaps first.
 */
export function dealDrift(rows: DealRow[]) {
  const byOpp = new Map<string, DealRow[]>()
  for (const r of rows) if (r.sfdc_opportunity_id) byOpp.set(r.sfdc_opportunity_id, [...(byOpp.get(r.sfdc_opportunity_id) ?? []), r])
  const deals = [...byOpp].flatMap(([opportunityId, rs]) => {
    const sorted = [...rs].sort((a, b) => a.captured_at.getTime() - b.captured_at.getTime())
    const won = sorted.find(r => r.event === 'WON')
    if (!won || won.sf_amount == null) return []
    const latestQuote = new Map<string, number>()
    for (const r of sorted) if ((r.event === 'BOOKED' || r.event === 'REVISED') && r.booking_key && r.app_quoted_total != null) latestQuote.set(r.booking_key, r.app_quoted_total)
    if (latestQuote.size === 0) return []
    const quoted = sum([...latestQuote.values()])
    const amounts = sorted.filter(r => (r.event === 'WON' || r.event === 'AMOUNT_CHANGED') && r.sf_amount != null)
    const current = amounts[amounts.length - 1].sf_amount!
    return [{
      opportunityId, client: won.client_name || sorted[0].client_name, quoted, wonAmount: won.sf_amount, currentAmount: current,
      drift: Math.round((current - quoted) * 100) / 100, driftPct: quoted ? pct(current - quoted, quoted) : 0,
    }]
  })
  const quoted = sum(deals.map(d => d.quoted)), current = sum(deals.map(d => d.currentAmount))
  return {
    wonDeals: deals.length, quoted, contract: current,
    drift: Math.round((current - quoted) * 100) / 100, driftPct: quoted ? pct(current - quoted, quoted) : 0,
    biggest: [...deals].sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift)).slice(0, 15),
  }
}

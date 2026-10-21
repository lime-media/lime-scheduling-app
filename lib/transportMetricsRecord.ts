/**
 * Transport and deal-value metrics: the writers (the pure half and the KPIs
 * are lib/transportMetrics.ts). Every function here is best-effort: it logs
 * and returns on any failure, including the tables not existing yet, so a
 * metrics problem can never block or fail a booking. Server only.
 *
 *   recordBooking          BOOKED / REVISED legs per truck + the booking's quoted total
 *   recordSwap             a SWAPPED leg for the truck swapped onto a hold
 *   recordPrestart         PRESTART snapshots: where a truck sits before it moves (the sweep)
 *   recordExecuted         EXECUTED legs on a campaign's first day (the sweep)
 *   recordWon              Salesforce's Amount when an opportunity is Closed Won
 *   recordAmountChanges    a won opportunity's Amount, again, when it changes (the sweep)
 */

import { prisma } from '@/lib/prisma'
import { bookingKey } from '@/lib/bookings'
import { loadFleetTimelines } from '@/lib/fleetTimelines'
import { HIDDEN_TRUCKS } from '@/lib/hiddenTrucks'
import { windowOccupancy } from '@/lib/truckTimeline'
import { checkChainFeasibility } from '@/lib/chainFeasibility'
import { resolveCampaignCoords, resolveDefaultRateOverrides } from '@/lib/pricing/resolvers'
import { SERVICE_AREA_RADIUS_MILES } from '@/lib/pricing/config'
import { isSfdcConfigured, sfdcQuery } from '@/lib/salesforceClient'
import { QUOTE_ONLY_ORIGINATION } from '@/lib/quoteOnly'
import {
  LIVE_HOLD_STATUSES, activationDaysOf, executedCandidates, executedOrigin, leadBusinessDays, legCost, legFromInbound, legOutcome,
  prestartCandidates, type LegEvent, type MeasuredLeg,
} from '@/lib/transportMetrics'

type HoldForLeg = {
  id: string; campaign_group_id: string | null; sfdc_opportunity_id: string | null; client_name: string
  market: string; truck_number: string; start_date: Date; end_date: Date; features: string | null; created_at: Date
}

const day = (d: Date) => d.toISOString().slice(0, 10)

function legRow(event: LegEvent, hold: HoldForLeg, leg: MeasuredLeg, createdBy: string | null, key?: string | null) {
  return {
    event,
    hold_id: hold.id,
    booking_key: key ?? bookingKey(hold),
    sfdc_opportunity_id: hold.sfdc_opportunity_id,
    client_name: hold.client_name,
    market: hold.market,
    campaign_start: hold.start_date,
    campaign_end: hold.end_date,
    activation_days: activationDaysOf(hold.features),
    lead_business_days: leadBusinessDays(hold.created_at, hold.start_date),
    truck_number: leg.truckNumber,
    origin_label: leg.originLabel.slice(0, 200),
    origin_kind: leg.originKind,
    miles: leg.miles,
    transport_days: leg.transportDays,
    outcome: legOutcome(leg.repositions, leg.charge),
    charge: leg.charge,
    est_cost: legCost(leg.repositions, leg.transportDays),
    created_by: createdBy,
  }
}

/**
 * A booking (or a revision of one): a leg per truck per market, from what the
 * quote already worked out, and the booking's quoted total. `groups` are the
 * campaign groups the holds were written under, each with its trucks' legs; a
 * truck held in several stretches of one market is one leg (its first hold).
 *
 * A revision replaces the booking's holds under a new campaign group, so its
 * booking key changes. `revised` names what it replaces: the new rows keep
 * the key the replaced holds were recorded under (else the key being revised),
 * so a booking's BOOKED, REVISED and SWAPPED rows and its quoted totals stay
 * one booking across any number of revisions.
 */
export async function recordBooking(o: {
  event: 'BOOKED' | 'REVISED'
  groups: { groupId: string; legs: MeasuredLeg[] }[]
  appQuotedTotal: number
  createdBy: string | null
  revised?: { holdIds: string[]; bookingKey: string }
}): Promise<void> {
  try {
    const holds = await prisma.hold.findMany({
      where: { campaign_group_id: { in: o.groups.map(g => g.groupId) }, origination: { not: QUOTE_ONLY_ORIGINATION } },
      orderBy: { start_date: 'asc' },
    })
    if (holds.length === 0) return
    const lineage = o.revised
      ? (o.revised.holdIds.length
          ? (await prisma.transportLeg.findFirst({
              where: { hold_id: { in: o.revised.holdIds }, booking_key: { not: null } },
              select: { booking_key: true },
            }))?.booking_key
          : null) ?? o.revised.bookingKey
      : null
    // One timestamp for every row: the KPIs tell one revision from the next by it.
    const at = new Date()
    const rows = o.groups.flatMap(g => g.legs.flatMap(leg => {
      const hold = holds.find(h => h.campaign_group_id === g.groupId && h.truck_number === leg.truckNumber)
      return hold ? [{ ...legRow(o.event, hold, leg, o.createdBy, lineage), created_at: at }] : []
    }))
    if (rows.length) await prisma.transportLeg.createMany({ data: rows })
    await prisma.dealValue.create({
      data: {
        event: o.event,
        sfdc_opportunity_id: holds.find(h => h.sfdc_opportunity_id)?.sfdc_opportunity_id ?? null,
        booking_key: lineage ?? bookingKey(holds[0]),
        client_name: holds[0].client_name,
        app_quoted_total: o.appQuotedTotal,
        created_by: o.createdBy,
      },
    })
  } catch (err) {
    console.error('[transport-metrics] recordBooking failed:', err)
  }
}

/**
 * Measures where trucks come from, loading the fleet once. Nothing is excluded
 * from the timelines: the measured hold itself straddles its own window, which
 * the chain check treats as neither predecessor nor successor, while every
 * other hold (another hold of the same batch, an earlier market of the same
 * booking) is a real prior job the truck drives in from.
 */
async function originMeasurer() {
  const [{ timelines, gpsMap }, overrides] = await Promise.all([
    loadFleetTimelines({ hiddenTrucks: HIDDEN_TRUCKS }),
    resolveDefaultRateOverrides(),
  ])
  const serviceAreaMiles = overrides?.service_area_miles ?? SERVICE_AREA_RADIUS_MILES
  const today = day(new Date())
  // Many holds share a market: resolve each market once.
  const coordsOf = new Map<string, ReturnType<typeof resolveCampaignCoords>>()
  return {
    serviceAreaMiles,
    async measure(hold: HoldForLeg, plannedCharge: number): Promise<MeasuredLeg | null> {
      if (!coordsOf.has(hold.market)) coordsOf.set(hold.market, resolveCampaignCoords(hold.market))
      const coords = await coordsOf.get(hold.market)!
      if (!coords) return null
      const start = day(hold.start_date), end = day(hold.end_date)
      const gps = gpsMap.get(hold.truck_number)
      const chain = checkChainFeasibility({
        campaignStart: start, campaignEnd: end, campaignCoords: coords,
        jobs: windowOccupancy(timelines.get(hold.truck_number) ?? [], start, end).jobs,
        currentCoords: gps?.latitude && gps?.longitude ? { lat: gps.latitude, lng: gps.longitude } : null,
        today, serviceAreaMiles,
      })
      return legFromInbound(hold.truck_number, chain.inbound, serviceAreaMiles, plannedCharge)
    },
  }
}
type OriginMeasurer = Awaited<ReturnType<typeof originMeasurer>>

/**
 * One fleet load shared by the sweep's recorders (a fleet and GPS load each
 * otherwise), made only when one of them has holds to measure.
 */
export function sharedOriginMeasurer(): () => Promise<OriginMeasurer> {
  let loading: Promise<OriginMeasurer> | null = null
  return () => (loading ??= originMeasurer())
}

/**
 * Each hold's latest planned leg: what the client pays for its transport (0 if
 * none recorded), and the booking key it was recorded under. A revision's rows
 * keep the original booking's key while its holds carry a new campaign group,
 * so later rows for those holds take the recorded key, not bookingKey(hold).
 */
async function plannedLegs(holdIds: string[]): Promise<Map<string, { charge: number; bookingKey: string | null }>> {
  const legs = await prisma.transportLeg.findMany({
    where: { hold_id: { in: holdIds }, event: { in: ['BOOKED', 'SWAPPED', 'REVISED'] } },
    orderBy: { created_at: 'asc' },
    select: { hold_id: true, charge: true, booking_key: true },
  })
  return new Map(legs.map(l => [l.hold_id!, { charge: Number(l.charge), bookingKey: l.booking_key }]))
}

/** A truck swapped onto a hold: where the new truck comes from, measured now. */
export async function recordSwap(holdId: string, createdBy: string | null): Promise<void> {
  try {
    const hold = await prisma.hold.findUnique({ where: { id: holdId } })
    if (!hold || hold.origination === QUOTE_ONLY_ORIGINATION) return
    const [measurer, planned] = await Promise.all([originMeasurer(), plannedLegs([hold.id])])
    const was = planned.get(hold.id)
    const leg = await measurer.measure(hold, was?.charge ?? 0)
    if (leg) await prisma.transportLeg.create({ data: legRow('SWAPPED', hold, leg, createdBy, was?.bookingKey) })
  } catch (err) {
    console.error('[transport-metrics] recordSwap failed:', err)
  }
}

// Bounded work per sweep (it runs every 15 minutes).
const EXECUTED_BATCH = 200
const PRESTART_BATCH = 200

/**
 * The sweep: holds starting in the next 3 days that have no PRESTART snapshot
 * get one: where their truck sits now (its last job before the start, else its
 * live GPS), before it drives in. On the first day the EXECUTED record takes
 * its origin from this when the truck had no prior job (lib/transportMetrics.ts
 * executedOrigin). Once per hold and truck (a truck swapped on gets its own).
 * Returns how many were recorded.
 */
export async function recordPrestart(measurerOf: () => Promise<OriginMeasurer> = sharedOriginMeasurer()): Promise<number> {
  try {
    const today = day(new Date())
    const until = new Date(today + 'T23:59:59Z')
    until.setUTCDate(until.getUTCDate() + 3)
    const window = { status: { in: LIVE_HOLD_STATUSES }, origination: { not: QUOTE_ONLY_ORIGINATION }, start_date: { gt: new Date(today + 'T23:59:59Z'), lte: until } }
    const upcoming = await prisma.hold.findMany({ where: window, select: { id: true, status: true, origination: true, start_date: true, truck_number: true } })
    if (upcoming.length === 0) return 0
    const done = await prisma.transportLeg.findMany({
      where: { event: 'PRESTART', hold_id: { in: upcoming.map(h => h.id) } },
      select: { hold_id: true, truck_number: true },
    })
    // Snapped for the truck now on the hold: a truck swapped on after the
    // snapshot gets its own (EXECUTED only uses a snapshot of the same truck).
    const truckOf = new Map(upcoming.map(h => [h.id, h.truck_number]))
    const snapped = new Set(done.filter(d => truckOf.get(d.hold_id!) === d.truck_number).map(d => d.hold_id!))
    const todoIds = prestartCandidates(upcoming, snapped, today).slice(0, PRESTART_BATCH).map(h => h.id)
    if (todoIds.length === 0) return 0
    const todo = await prisma.hold.findMany({ where: { id: { in: todoIds } } })
    if (todo.length === 0) return 0
    const [measurer, planned] = await Promise.all([measurerOf(), plannedLegs(todo.map(h => h.id))])
    const rows = []
    for (const hold of todo) {
      const was = planned.get(hold.id)
      const leg = await measurer.measure(hold, was?.charge ?? 0)
      if (leg) rows.push(legRow('PRESTART', hold, leg, null, was?.bookingKey))
    }
    if (rows.length) await prisma.transportLeg.createMany({ data: rows })
    return rows.length
  } catch (err) {
    console.error('[transport-metrics] recordPrestart failed:', err)
    return 0
  }
}

/**
 * The sweep: holds whose first day has come and that have no EXECUTED record
 * get one, for the truck actually on the hold: from its last job before the
 * start, else its PRESTART snapshot (taken before it moved, same truck), else
 * its live GPS (executedOrigin). Once per hold. Returns how many were recorded.
 */
export async function recordExecuted(measurerOf: () => Promise<OriginMeasurer> = sharedOriginMeasurer()): Promise<number> {
  try {
    const today = day(new Date())
    const from = new Date(today + 'T00:00:00Z')
    from.setUTCDate(from.getUTCDate() - 3)
    // Every candidate in the window (ids only), so the batch below is taken
    // from the ones not yet recorded, never cut before the done ones drop out.
    const window = { status: { in: LIVE_HOLD_STATUSES }, origination: { not: QUOTE_ONLY_ORIGINATION }, start_date: { gte: from, lte: new Date(today + 'T23:59:59Z') } }
    const recent = await prisma.hold.findMany({ where: window, select: { id: true, status: true, origination: true, start_date: true } })
    if (recent.length === 0) return 0
    const done = await prisma.transportLeg.findMany({
      where: { event: 'EXECUTED', hold_id: { in: recent.map(h => h.id) } },
      select: { hold_id: true },
    })
    const todoIds = executedCandidates(recent, new Set(done.map(d => d.hold_id!)), today).slice(0, EXECUTED_BATCH).map(h => h.id)
    if (todoIds.length === 0) return 0
    const todo = await prisma.hold.findMany({ where: { id: { in: todoIds } } })
    if (todo.length === 0) return 0
    const [measurer, planned, snapshots] = await Promise.all([
      measurerOf(),
      plannedLegs(todo.map(h => h.id)),
      prisma.transportLeg.findMany({
        where: { event: 'PRESTART', hold_id: { in: todo.map(h => h.id) } },
        orderBy: { created_at: 'asc' },
        select: { hold_id: true, truck_number: true, origin_label: true, origin_kind: true, miles: true, transport_days: true },
      }),
    ])
    // The latest snapshot of each hold's current truck (a swap leaves the old truck's behind).
    const prestartOf = new Map(snapshots.map(s => [`${s.hold_id}|${s.truck_number}`, s]))
    const rows = []
    for (const hold of todo) {
      const was = planned.get(hold.id)
      const measured = await measurer.measure(hold, was?.charge ?? 0)
      if (measured) rows.push(legRow('EXECUTED', hold, executedOrigin(measured, prestartOf.get(`${hold.id}|${hold.truck_number}`) ?? null, measurer.serviceAreaMiles), null, was?.bookingKey))
    }
    if (rows.length) await prisma.transportLeg.createMany({ data: rows })
    return rows.length
  } catch (err) {
    console.error('[transport-metrics] recordExecuted failed:', err)
    return 0
  }
}

/** An opportunity went Closed Won: Salesforce's Amount at that moment, against what the app quoted. */
export async function recordWon(o: { opportunityId: string; amount: number | null; stageName: string; clientName: string }): Promise<void> {
  try {
    await prisma.dealValue.create({
      data: { event: 'WON', sfdc_opportunity_id: o.opportunityId, client_name: o.clientName, sf_amount: o.amount, sf_stage: o.stageName },
    })
  } catch (err) {
    console.error('[transport-metrics] recordWon failed:', err)
  }
}

const SFDC_ID = /^[a-zA-Z0-9]{15,18}$/
const AMOUNT_BATCH = 200

/**
 * The sweep: for won opportunities the app has a WON record for, re-reads
 * Salesforce's Amount and records it when it differs from the last captured.
 * Skipped quietly when Salesforce isn't configured. Returns how many changed.
 */
// Won deals are re-checked for Amount changes for this long after they were
// won; after that a change is rare and no longer about the quote. Keeps the
// 15-minute sweep's reads and Salesforce calls from growing without limit.
const AMOUNT_RECHECK_DAYS = 180

export async function recordAmountChanges(): Promise<number> {
  if (!isSfdcConfigured()) return 0
  try {
    const since = new Date(Date.now() - AMOUNT_RECHECK_DAYS * 86_400_000)
    const recent = await prisma.dealValue.findMany({
      where:    { event: 'WON', sfdc_opportunity_id: { not: null }, captured_at: { gte: since } },
      select:   { sfdc_opportunity_id: true },
      distinct: ['sfdc_opportunity_id'],
    })
    const recentIds = recent.map(r => r.sfdc_opportunity_id!)
    if (recentIds.length === 0) return 0
    const won = await prisma.dealValue.findMany({
      where: { event: { in: ['WON', 'AMOUNT_CHANGED'] }, sfdc_opportunity_id: { in: recentIds } },
      orderBy: { captured_at: 'asc' },
      select: { sfdc_opportunity_id: true, sf_amount: true, client_name: true },
    })
    const last = new Map<string, { amount: number | null; client: string }>()
    for (const r of won) last.set(r.sfdc_opportunity_id!, { amount: r.sf_amount == null ? null : Number(r.sf_amount), client: r.client_name })
    const ids = [...last.keys()].filter(id => SFDC_ID.test(id))
    if (ids.length === 0) return 0
    // Every won opportunity, in SOQL-sized batches (none is left unchecked).
    const rows: { Id: string; Amount: number | null; StageName: string }[] = []
    for (let i = 0; i < ids.length; i += AMOUNT_BATCH) {
      rows.push(...await sfdcQuery<{ Id: string; Amount: number | null; StageName: string }>(
        `SELECT Id, Amount, StageName FROM Opportunity WHERE Id IN (${ids.slice(i, i + AMOUNT_BATCH).map(id => `'${id}'`).join(',')})`,
      ))
    }
    const key = (id: string) => id.slice(0, 15)
    const byKey = new Map(ids.map(id => [key(id), id]))
    const changed = rows.flatMap(r => {
      const id = byKey.get(key(r.Id))
      const was = id ? last.get(id) : undefined
      // Compared in cents, as stored (DECIMAL(14,2)): a Salesforce Amount with
      // more decimals would otherwise read as changed on every sweep.
      const cents = (n: number | null) => (n == null ? null : Math.round(n * 100))
      if (!id || !was || cents(was.amount) === cents(r.Amount ?? null)) return []
      return [{ event: 'AMOUNT_CHANGED', sfdc_opportunity_id: id, client_name: was.client, sf_amount: r.Amount ?? null, sf_stage: r.StageName }]
    })
    if (changed.length) await prisma.dealValue.createMany({ data: changed })
    return changed.length
  } catch (err) {
    console.error('[transport-metrics] recordAmountChanges failed:', err)
    return 0
  }
}

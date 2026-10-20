/**
 * Transport and deal-value metrics: the writers (the pure half and the KPIs
 * are lib/transportMetrics.ts). Every function here is best-effort: it logs
 * and returns on any failure, including the tables not existing yet, so a
 * metrics problem can never block or fail a booking. Server only.
 *
 *   recordBooking          BOOKED / REVISED legs per truck + the booking's quoted total
 *   recordSwap             a SWAPPED leg for the truck swapped onto a hold
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
  activationDaysOf, executedCandidates, leadBusinessDays, legCost, legFromInbound, legOutcome,
  type LegEvent, type MeasuredLeg,
} from '@/lib/transportMetrics'

type HoldForLeg = {
  id: string; campaign_group_id: string | null; sfdc_opportunity_id: string | null; client_name: string
  market: string; truck_number: string; start_date: Date; end_date: Date; features: string | null; created_at: Date
}

const day = (d: Date) => d.toISOString().slice(0, 10)

function legRow(event: LegEvent, hold: HoldForLeg, leg: MeasuredLeg, createdBy: string | null) {
  return {
    event,
    hold_id: hold.id,
    booking_key: bookingKey(hold),
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
 */
export async function recordBooking(o: {
  event: 'BOOKED' | 'REVISED'
  groups: { groupId: string; legs: MeasuredLeg[] }[]
  appQuotedTotal: number
  createdBy: string | null
}): Promise<void> {
  try {
    const holds = await prisma.hold.findMany({
      where: { campaign_group_id: { in: o.groups.map(g => g.groupId) }, origination: { not: QUOTE_ONLY_ORIGINATION } },
      orderBy: { start_date: 'asc' },
    })
    if (holds.length === 0) return
    const rows = o.groups.flatMap(g => g.legs.flatMap(leg => {
      const hold = holds.find(h => h.campaign_group_id === g.groupId && h.truck_number === leg.truckNumber)
      return hold ? [legRow(o.event, hold, leg, o.createdBy)] : []
    }))
    if (rows.length) await prisma.transportLeg.createMany({ data: rows })
    await prisma.dealValue.create({
      data: {
        event: o.event,
        sfdc_opportunity_id: holds.find(h => h.sfdc_opportunity_id)?.sfdc_opportunity_id ?? null,
        booking_key: bookingKey(holds[0]),
        client_name: holds[0].client_name,
        app_quoted_total: o.appQuotedTotal,
        created_by: o.createdBy,
      },
    })
  } catch (err) {
    console.error('[transport-metrics] recordBooking failed:', err)
  }
}

/** Measures where trucks come from for given holds, loading the fleet once. */
async function originMeasurer(excludeHoldIds: Set<string>) {
  const [{ timelines, gpsMap }, overrides] = await Promise.all([
    loadFleetTimelines({ hiddenTrucks: HIDDEN_TRUCKS, excludeHoldIds }),
    resolveDefaultRateOverrides(),
  ])
  const serviceAreaMiles = overrides?.service_area_miles ?? SERVICE_AREA_RADIUS_MILES
  const today = day(new Date())
  return {
    serviceAreaMiles,
    async measure(hold: HoldForLeg, plannedCharge: number): Promise<MeasuredLeg | null> {
      const coords = await resolveCampaignCoords(hold.market)
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

/** What the client pays for a hold's transport: its latest planned leg's charge (0 if none recorded). */
async function plannedCharges(holdIds: string[]): Promise<Map<string, number>> {
  const legs = await prisma.transportLeg.findMany({
    where: { hold_id: { in: holdIds }, event: { not: 'EXECUTED' } },
    orderBy: { created_at: 'asc' },
    select: { hold_id: true, charge: true },
  })
  return new Map(legs.map(l => [l.hold_id!, Number(l.charge)]))
}

/** A truck swapped onto a hold: where the new truck comes from, measured now. */
export async function recordSwap(holdId: string, createdBy: string | null): Promise<void> {
  try {
    const hold = await prisma.hold.findUnique({ where: { id: holdId } })
    if (!hold || hold.origination === QUOTE_ONLY_ORIGINATION) return
    const measurer = await originMeasurer(new Set([hold.id]))
    const leg = await measurer.measure(hold, (await plannedCharges([hold.id])).get(hold.id) ?? 0)
    if (leg) await prisma.transportLeg.create({ data: legRow('SWAPPED', hold, leg, createdBy) })
  } catch (err) {
    console.error('[transport-metrics] recordSwap failed:', err)
  }
}

// Bounded work per sweep (it runs every 15 minutes).
const EXECUTED_BATCH = 200

/**
 * The sweep: holds whose first day has come and that have no EXECUTED record
 * get one, for the truck actually on the hold, from its last job before the
 * start, else its live GPS. Once per hold. Returns how many were recorded.
 */
export async function recordExecuted(): Promise<number> {
  try {
    const today = day(new Date())
    const from = new Date(today + 'T00:00:00Z')
    from.setUTCDate(from.getUTCDate() - 3)
    const recent = await prisma.hold.findMany({
      where: { status: { in: ['HOLD', 'COMMITTED'] }, start_date: { gte: from, lte: new Date(today + 'T23:59:59Z') } },
      take: EXECUTED_BATCH * 2,
    })
    if (recent.length === 0) return 0
    const done = await prisma.transportLeg.findMany({
      where: { event: 'EXECUTED', hold_id: { in: recent.map(h => h.id) } },
      select: { hold_id: true },
    })
    const todo = executedCandidates(recent, new Set(done.map(d => d.hold_id!)), today).slice(0, EXECUTED_BATCH)
    if (todo.length === 0) return 0
    const [measurer, charges] = await Promise.all([originMeasurer(new Set(todo.map(h => h.id))), plannedCharges(todo.map(h => h.id))])
    const rows = []
    for (const hold of todo) {
      const leg = await measurer.measure(hold, charges.get(hold.id) ?? 0)
      if (leg) rows.push(legRow('EXECUTED', hold, leg, null))
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
export async function recordAmountChanges(): Promise<number> {
  if (!isSfdcConfigured()) return 0
  try {
    const won = await prisma.dealValue.findMany({
      where: { event: { in: ['WON', 'AMOUNT_CHANGED'] }, sfdc_opportunity_id: { not: null } },
      orderBy: { captured_at: 'asc' },
      select: { sfdc_opportunity_id: true, sf_amount: true, client_name: true },
    })
    const last = new Map<string, { amount: number | null; client: string }>()
    for (const r of won) last.set(r.sfdc_opportunity_id!, { amount: r.sf_amount == null ? null : Number(r.sf_amount), client: r.client_name })
    const ids = [...last.keys()].filter(id => SFDC_ID.test(id)).slice(0, AMOUNT_BATCH)
    if (ids.length === 0) return 0
    const rows = await sfdcQuery<{ Id: string; Amount: number | null; StageName: string }>(
      `SELECT Id, Amount, StageName FROM Opportunity WHERE Id IN (${ids.map(id => `'${id}'`).join(',')})`,
    )
    const key = (id: string) => id.slice(0, 15)
    const changed = rows.flatMap(r => {
      const was = [...last].find(([id]) => key(id) === key(r.Id))
      if (!was || was[1].amount === r.Amount) return []
      return [{ event: 'AMOUNT_CHANGED', sfdc_opportunity_id: was[0], client_name: was[1].client, sf_amount: r.Amount, sf_stage: r.StageName }]
    })
    if (changed.length) await prisma.dealValue.createMany({ data: changed })
    return changed.length
  } catch (err) {
    console.error('[transport-metrics] recordAmountChanges failed:', err)
    return 0
  }
}

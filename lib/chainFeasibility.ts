/**
 * Chain feasibility — can this truck actually take this campaign?
 *
 * A booking sits between the truck's previous job and its next one:
 *
 *   [ prior job ] --travel--> [ THIS CAMPAIGN ] --travel--> [ next job ]
 *        Mp                          M                           Mn
 *
 * Three things have to hold, and all three are arithmetic on the same
 * distance -> transport-days function the quote uses:
 *
 *   1. ARRIVE      the truck can reach M from where it is released, in the
 *                  time between release and campaign start
 *   2. FREE        nothing else is booked during the campaign itself
 *                  (checked by the caller against the same timeline)
 *   3. NOT STRAND  the truck can still reach Mn in the gap we leave behind
 *
 * Rule 3 is what stops a new booking from breaking a reservation that is
 * already sold. A hard commitment cannot be stranded at all; a soft (ATT_SOFT)
 * hold may be, and is returned as overridable so a rep can make the call.
 *
 * Because feasibility is recomputed from the stored job chain every time, the
 * transit days never need to be written into the calendar to be respected: a
 * second campaign evaluated against the same truck sees the first campaign as
 * a job and has to route around it. Blocking transit days on the grid is a
 * display concern, not a correctness one.
 *
 * NOT modelled, by decision: repositioning home. A campaign that leaves a truck
 * far from anywhere with nothing after it carries no return leg — that has
 * never been priced and is not introduced here.
 */

import { haversineDistance, getMarketCoords } from '@/lib/marketCoordinates'
import { transportDaysFromDistance, needsRepositioning, chargeForLeg } from '@/lib/pricing/transport'
import { findPredecessor, findSuccessor, type TruckJob } from '@/lib/truckTimeline'

export type Coords = { lat: number; lng: number }

export type ChainInput = {
  campaignStart: string
  campaignEnd: string
  campaignCoords: Coords
  /** The truck's other jobs — schedule blocks and holds, any order. */
  jobs: TruckJob[]
  /** Live GPS / last known position, used only when no prior job exists. */
  currentCoords: Coords | null
  today: string
  serviceAreaMiles?: number
}

export type BlockedReason = 'CANNOT_ARRIVE' | 'STRANDS_SUCCESSOR' | 'UNKNOWN_ORIGIN'

export type InboundLeg = {
  /** Where the truck actually departs from — prior job's market, else current position. */
  originLabel: string
  originIsPriorJob: boolean
  distanceMiles: number
  transportDays: number
  /** Earliest the truck can leave: day after the prior job, else today. */
  earliestDeparture: string
  /** Days between earliest departure and campaign start. */
  daysAvailable: number
  /** False when neither a prior job nor a live position could be geocoded. */
  originResolved: boolean
  /**
   * Set only when an UPCOMING job's market could not be geocoded.
   *
   * When the unmappable job is already RUNNING, the truck is physically in that
   * market right now, so its live GPS reads the right place and the fallback is
   * accurate — nothing to verify. It is only when the job has not started yet
   * that GPS describes where the truck is instead of where it will depart from,
   * and the transport distance is genuinely wrong. Carries
   * the market string that failed, so drift between program_schedule market
   * names and the coordinate map is visible instead of silent.
   */
  originFellBackToGps?: string
}

export type SuccessorImpact = {
  market: string
  startsOn: string
  status: string
  yieldable: boolean
  /** Transport days from THIS campaign to the successor. */
  transportDays: number
  distanceMiles: number
  /** Days between campaign end and successor start. */
  gapDays: number
  /**
   * What the successor's inbound leg would have been WITHOUT this campaign —
   * the baseline it was quoted against.
   */
  baselineTransportDays: number
  baselineDistanceMiles: number
  /** Extra transport this booking imposes on the next job. Can be negative. */
  deltaTransportDays: number
  deltaCost: number
  /** True when the successor's market could not be geocoded — check skipped. */
  unresolvedMarket: boolean
}

export type ChainResult = {
  feasible: boolean
  blockedBy?: BlockedReason
  /** True only when the blocker is a soft hold a rep may displace. */
  overridable: boolean
  detail?: string
  inbound: InboundLeg
  successor: SuccessorImpact | null
}

// ---------------------------------------------------------------------------

function daysBetween(fromStr: string, toStr: string): number {
  const from = new Date(fromStr + 'T00:00:00Z').getTime()
  const to = new Date(toStr + 'T00:00:00Z').getTime()
  return Math.round((to - from) / 86400000)
}

function nextDay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().split('T')[0]
}

/**
 * Resolve a job's market to coordinates.
 *
 * Schedule rows usually carry the state INSIDE the market string already
 * ("Doral, FL") while also exposing it separately, so naive concatenation
 * produces "Doral, FL, FL" and misses. Try the market as written first, then
 * append the state only when it is not already there, then the bare city.
 */
export function coordsForJob(market: string, state: string): Coords | null {
  if (!market) return null

  const direct = getMarketCoords(market)
  if (direct) return direct

  if (state && !market.toLowerCase().endsWith(`, ${state.toLowerCase()}`)) {
    const withState = getMarketCoords(`${market}, ${state}`)
    if (withState) return withState
  }

  // Last resort: the city alone, in case the map keys it without a state.
  const city = market.split(',')[0].trim()
  return city && city !== market ? getMarketCoords(city) ?? null : null
}

/**
 * A job's coordinates, preferring the market's own geography over a name lookup.
 *
 * When standard_market_lookup carries bounding boxes, the centroid travels with
 * the job and is authoritative — it is the market the team actually selected,
 * not a guess from a 281-entry name file that covers 61% of them. The name
 * lookup stays as the fallback for holds (which carry no market uid) and for
 * databases where the bounds migration has not landed.
 */
export function jobCoords(job: { market: string; state: string; lat?: number; lng?: number }): Coords | null {
  if (typeof job.lat === 'number' && typeof job.lng === 'number') {
    return { lat: job.lat, lng: job.lng }
  }
  return coordsForJob(job.market, job.state)
}

/** Human label for a job's market, without duplicating the state. */
export function jobMarketLabel(market: string, state: string): string {
  if (!market) return state || 'unknown'
  if (!state || market.toLowerCase().endsWith(`, ${state.toLowerCase()}`)) return market
  return `${market}, ${state}`
}

/** Transport days for a leg — 0 when the distance is inside the service area. */
function legDays(distanceMiles: number, serviceAreaMiles?: number): number {
  return needsRepositioning(distanceMiles, serviceAreaMiles)
    ? transportDaysFromDistance(distanceMiles)
    : 0
}

function legCost(distanceMiles: number, serviceAreaMiles?: number): number {
  return needsRepositioning(distanceMiles, serviceAreaMiles) ? chargeForLeg(distanceMiles) : 0
}

// ---------------------------------------------------------------------------

export function checkChainFeasibility(input: ChainInput): ChainResult {
  const {
    campaignStart, campaignEnd, campaignCoords,
    jobs, currentCoords, today, serviceAreaMiles,
  } = input

  const predecessor = findPredecessor(jobs, campaignStart, today)
  const successor = findSuccessor(jobs, campaignEnd)

  // --- Inbound leg: measured from where the truck will actually BE.
  //
  // Two sources, and which one applies depends on whether the truck is
  // committed between now and the campaign:
  //
  //   committed  — running a program now, or scheduled for one before the
  //                campaign starts: use that program's market. A truck working
  //                Miami until the 12th is a Miami truck for a campaign on the
  //                14th, wherever its GPS reads today.
  //
  //   free       — no current or upcoming commitment before the campaign: use
  //                live GPS. A campaign it finished weeks ago is not evidence
  //                of position; trucks get repositioned between jobs.
  //
  // Using a past job's market was wrong in exactly the case that matters most:
  // an idle truck that has since been moved.
  const predCoords = predecessor ? jobCoords(predecessor) : null
  const originCoords = predCoords ?? currentCoords
  const originIsPriorJob = predCoords !== null
  const earliestDeparture = predecessor ? nextDay(predecessor.end) : today

  const inboundDistance = originCoords
    ? Math.round(haversineDistance(originCoords.lat, originCoords.lng, campaignCoords.lat, campaignCoords.lng) * 10) / 10
    : 0
  const inboundDays = originCoords ? legDays(inboundDistance, serviceAreaMiles) : 0
  const daysAvailable = daysBetween(earliestDeparture, campaignStart)

  const inbound: InboundLeg = {
    originLabel: predecessor
      ? jobMarketLabel(predecessor.market, predecessor.state)
      : 'current position',
    originIsPriorJob,
    distanceMiles: inboundDistance,
    transportDays: inboundDays,
    earliestDeparture,
    daysAvailable,
    originResolved: originCoords !== null,
    // Upcoming (not yet started) unmappable job only — see the field docs.
    originFellBackToGps:
      predecessor && !predCoords && predecessor.start > today
        ? jobMarketLabel(predecessor.market, predecessor.state)
        : undefined,
  }

  // No usable origin — we cannot plan logistics for this truck at all. Surfaced
  // rather than dropped, so missing GPS shows up as a data gap, not thin supply.
  if (!originCoords) {
    return {
      feasible: false,
      blockedBy: 'UNKNOWN_ORIGIN',
      overridable: false,
      detail: 'No prior job market or live position — cannot determine where this truck departs from.',
      inbound,
      successor: null,
    }
  }

  // --- Successor impact, computed even when the campaign is feasible so the
  // added deadhead can be flagged.
  let successorImpact: SuccessorImpact | null = null
  if (successor) {
    const succCoords = jobCoords(successor)
    // Symmetric with the inbound leg: the campaign's final day is occupied by
    // the campaign, exactly as the predecessor's final day is occupied by the
    // predecessor. Travel can only start the day AFTER. Counting from
    // campaignEnd would hand the truck a free travel day it does not have and
    // let a one-day leg slip past a back-to-back commitment.
    const gapDays = daysBetween(nextDay(campaignEnd), successor.start)

    if (!succCoords) {
      successorImpact = {
        market: jobMarketLabel(successor.market, successor.state),
        startsOn: successor.start,
        status: successor.status ?? successor.source,
        yieldable: successor.yieldable,
        transportDays: 0, distanceMiles: 0, gapDays,
        baselineTransportDays: 0, baselineDistanceMiles: 0,
        deltaTransportDays: 0, deltaCost: 0,
        unresolvedMarket: true,
      }
    } else {
      const outDistance = Math.round(haversineDistance(campaignCoords.lat, campaignCoords.lng, succCoords.lat, succCoords.lng) * 10) / 10
      const outDays = legDays(outDistance, serviceAreaMiles)

      // Baseline: what the successor's approach would have been had we not
      // taken the truck — from wherever it was released before our campaign.
      const baseDistance = originCoords
        ? Math.round(haversineDistance(originCoords.lat, originCoords.lng, succCoords.lat, succCoords.lng) * 10) / 10
        : outDistance
      const baseDays = originCoords ? legDays(baseDistance, serviceAreaMiles) : outDays

      successorImpact = {
        market: jobMarketLabel(successor.market, successor.state),
        startsOn: successor.start,
        status: successor.status ?? successor.source,
        yieldable: successor.yieldable,
        transportDays: outDays,
        distanceMiles: outDistance,
        gapDays,
        baselineTransportDays: baseDays,
        baselineDistanceMiles: baseDistance,
        deltaTransportDays: outDays - baseDays,
        deltaCost: legCost(outDistance, serviceAreaMiles) - legCost(baseDistance, serviceAreaMiles),
        unresolvedMarket: false,
      }
    }
  }

  // --- Rule 1: can it arrive? Physics — never overridable.
  if (inboundDays > daysAvailable) {
    return {
      feasible: false,
      blockedBy: 'CANNOT_ARRIVE',
      overridable: false,
      detail: `Needs ${inboundDays} transport day${inboundDays === 1 ? '' : 's'} from ${inbound.originLabel} (${inboundDistance} mi) but only ${daysAvailable} day${daysAvailable === 1 ? '' : 's'} before start.`,
      inbound,
      successor: successorImpact,
    }
  }

  // --- Rule 3: does it strand the next commitment?
  if (successorImpact && !successorImpact.unresolvedMarket
      && successorImpact.transportDays > successorImpact.gapDays) {
    return {
      feasible: false,
      blockedBy: 'STRANDS_SUCCESSOR',
      overridable: successorImpact.yieldable,
      detail: `Would strand ${successorImpact.status} in ${successorImpact.market} on ${successorImpact.startsOn}: needs ${successorImpact.transportDays} transport day${successorImpact.transportDays === 1 ? '' : 's'} but only ${successorImpact.gapDays} day${successorImpact.gapDays === 1 ? '' : 's'} follow this campaign.`,
      inbound,
      successor: successorImpact,
    }
  }

  return { feasible: true, overridable: false, inbound, successor: successorImpact }
}

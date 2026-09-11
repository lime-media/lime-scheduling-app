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
   * Set when a prior job EXISTS but its market could not be geocoded, so the
   * truck silently fell back to live GPS — i.e. the old, wrong basis. Carries
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

/** Resolve a job's market to coordinates, trying "city, st" then bare city. */
export function coordsForJob(market: string, state: string): Coords | null {
  if (!market) return null
  return getMarketCoords(state ? `${market}, ${state}` : market) ?? getMarketCoords(market)
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

  const predecessor = findPredecessor(jobs, campaignStart)
  const successor = findSuccessor(jobs, campaignEnd)

  // --- Inbound leg: measured from where the truck is RELEASED, not where it
  // happens to be sitting today. A truck working Miami until the 12th is a
  // Miami truck for a campaign starting the 14th, wherever its GPS reads now.
  const predCoords = predecessor ? coordsForJob(predecessor.market, predecessor.state) : null
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
      ? [predecessor.market, predecessor.state].filter(Boolean).join(', ')
      : 'current position',
    originIsPriorJob,
    distanceMiles: inboundDistance,
    transportDays: inboundDays,
    earliestDeparture,
    daysAvailable,
    originResolved: originCoords !== null,
    originFellBackToGps:
      predecessor && !predCoords
        ? ([predecessor.market, predecessor.state].filter(Boolean).join(', ') || 'unknown')
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
    const succCoords = coordsForJob(successor.market, successor.state)
    // Symmetric with the inbound leg: the campaign's final day is occupied by
    // the campaign, exactly as the predecessor's final day is occupied by the
    // predecessor. Travel can only start the day AFTER. Counting from
    // campaignEnd would hand the truck a free travel day it does not have and
    // let a one-day leg slip past a back-to-back commitment.
    const gapDays = daysBetween(nextDay(campaignEnd), successor.start)

    if (!succCoords) {
      successorImpact = {
        market: [successor.market, successor.state].filter(Boolean).join(', ') || 'unknown',
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
        market: [successor.market, successor.state].filter(Boolean).join(', '),
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

/**
 * Other dates that would work, for a quote with too few trucks.
 *
 * A truck that cannot take the campaign often could with a small change:
 *  - a later START, when it finishes a job far away just before (it cannot
 *    arrive in time), or a job runs into the first days;
 *  - an earlier END, when it has a job soon after (it could not get there
 *    in time), or a job starts in the last days.
 * Each excluded truck is re-tested with the start moved later, or the end
 * moved earlier, a day at a time, by the same rules the quote uses. Never
 * both at once: one change is something a rep can offer a client.
 *
 * Pure, so it can be tested; checkAvailability supplies each truck's jobs.
 */

import { windowOccupancy, type TruckJob } from '@/lib/truckTimeline'
import { checkChainFeasibility, type Coords } from '@/lib/chainFeasibility'

/** How far the start or end is moved, at most. */
export const ALTERNATIVE_SHIFT_DAYS = 14

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10)

type Fit = {
  jobs: TruckJob[]
  campaignCoords: Coords
  currentCoords: Coords | null
  today: string
  serviceAreaMiles?: number
  /** Staff quotes: leaving a LATER AT&T soft hold short of travel time is a warning, not a block. */
  softHoldStrandIsWarning?: boolean
}

/** Can this truck take [start, end] cleanly — no release, no override? */
export function fitsWindow(o: Fit & { start: string; end: string }): boolean {
  const w = windowOccupancy(o.jobs, o.start, o.end)
  if (w.blocked || w.softHeld) return false
  const c = checkChainFeasibility({
    campaignStart: o.start, campaignEnd: o.end, campaignCoords: o.campaignCoords,
    jobs: o.jobs, currentCoords: o.currentCoords, today: o.today, serviceAreaMiles: o.serviceAreaMiles,
  })
  return c.feasible || (!!o.softHoldStrandIsWarning && c.overridable)
}

/** The nearest start (later) and end (earlier) that would let this truck take the campaign. */
export function windowAlternatives(o: Fit & { start: string; end: string }): { earliestStart?: string; latestEnd?: string } {
  const out: { earliestStart?: string; latestEnd?: string } = {}
  for (let d = 1; d <= ALTERNATIVE_SHIFT_DAYS; d++) {
    const start = addDays(o.start, d)
    if (start > o.end) break
    if (fitsWindow({ ...o, start })) { out.earliestStart = start; break }
  }
  for (let d = 1; d <= ALTERNATIVE_SHIFT_DAYS; d++) {
    const end = addDays(o.end, -d)
    if (end < o.start) break
    if (fitsWindow({ ...o, end })) { out.latestEnd = end; break }
  }
  return out
}

export type DateOption = { date: string; trucks: number }

/**
 * The smallest change that gives enough trucks: the earliest later start, and
 * the latest earlier end, at which the trucks free now plus those that fit
 * reach `needed`. `trucks` is the total then available. Each option is a
 * suggestion; choosing it re-runs the quote, which decides.
 */
export function dateOptions(o: {
  freeNow: number
  needed: number
  alternatives: { earliestStart?: string; latestEnd?: string }[]
}): { startFrom?: DateOption; endBy?: DateOption } {
  const out: { startFrom?: DateOption; endBy?: DateOption } = {}
  const starts = o.alternatives.map(a => a.earliestStart).filter((d): d is string => !!d).sort()
  for (const [i, date] of starts.entries()) {
    if (starts[i + 1] === date) continue
    const trucks = o.freeNow + starts.filter(s => s <= date).length
    if (trucks >= o.needed) { out.startFrom = { date, trucks }; break }
  }
  const ends = o.alternatives.map(a => a.latestEnd).filter((d): d is string => !!d).sort().reverse()
  for (const [i, date] of ends.entries()) {
    if (ends[i + 1] === date) continue
    const trucks = o.freeNow + ends.filter(e => e >= date).length
    if (trucks >= o.needed) { out.endBy = { date, trucks }; break }
  }
  return out
}

const fmt = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const span = (a: string, b: string) => (a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`)
const trucksWord = (n: number) => `${n} truck${n === 1 ? '' : 's'}`
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5)

/**
 * How much shorter a date option makes the campaign. Moving the start later
 * or the end earlier both cut days, which changes the price — the rep should
 * see that before choosing it. Pure.
 */
export const daysShorter = (o: { start: string; end: string }, option: { startFrom?: string; endBy?: string }) =>
  option.startFrom ? daysBetween(o.start, option.startFrom) : option.endBy ? daysBetween(option.endBy, o.end) : 0

const shorter = (n: number) => `${n} day${n === 1 ? '' : 's'} shorter`

/**
 * What a quote with too few trucks tells the rep: the fact, then every way
 * forward the data offers — releasing AT&T soft holds, a later start, an
 * earlier end — instead of only "not feasible". Pure.
 */
export function insufficientSummary(o: {
  market: string
  start: string
  end: string
  requested: number
  free: number
  /** Trucks an AT&T soft-hold release for these dates would free. */
  releasable: number
  options: { startFrom?: DateOption; endBy?: DateOption }
}): { message: string; detail: string } {
  const message = o.free === 0
    ? `No truck is free and able to reach ${o.market} for ${span(o.start, o.end)}.`
    : `Only ${o.free} of ${trucksWord(o.requested)} ${o.free === 1 ? 'is' : 'are'} free and able to reach ${o.market} for ${span(o.start, o.end)}.`
  const ways: string[] = []
  // How many releases it takes, not how many trucks are soft-held nearby:
  // "31 trucks" next to "need 1" read as though it were trivially easy.
  const short = Math.max(1, o.requested - o.free)
  if (o.releasable > 0) {
    ways.push(`release the AT&T soft hold on ${trucksWord(Math.min(short, o.releasable))}`
      + (o.releasable > short ? ` (${o.releasable} held for AT&T to choose from, below)` : ' (below)'))
  }
  if (o.options.startFrom) ways.push(`start ${fmt(o.options.startFrom.date)} instead (${trucksWord(o.options.startFrom.trucks)}, ${shorter(daysShorter(o, { startFrom: o.options.startFrom.date }))})`)
  if (o.options.endBy) ways.push(`end ${fmt(o.options.endBy.date)} instead (${trucksWord(o.options.endBy.trucks)}, ${shorter(daysShorter(o, { endBy: o.options.endBy.date }))})`)
  const detail = ways.length
    ? `To book it: ${ways.length === 1 ? ways[0] : `${ways.slice(0, -1).join(', ')}, or ${ways[ways.length - 1]}`}.`
    : `No date within ${ALTERNATIVE_SHIFT_DAYS} days either way frees enough trucks. Price it as a quote only, or ask operations.`
  return { message, detail }
}

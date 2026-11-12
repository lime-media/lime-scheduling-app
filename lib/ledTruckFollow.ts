/**
 * A won reservation mirrors what LED runs: its trucks and its dates.
 *
 * Ops schedules a won job in LED, on whichever trucks and days work. Sales
 * doesn't care which truck runs it, but the reservation is what availability
 * reads for every future quote, so it has to say what LED actually runs
 * (Andrew, 2026-11-11). The link is the job number (lib/jobNumber.ts
 * linkedJob), so only committed holds with one ever change.
 *
 * For each won booking market (one booking, one market, one job):
 * - LED's days of the job in that market (lib/ledJobs.ts ledMarketMatches; a
 *   Salesforce multi-market label: a city it names), on any truck, from
 *   MIRROR_WINDOW_DAYS before the market's first day to as many after its last.
 * - Grouped by truck into runs of days. A gap made only of weekdays LED never
 *   runs this job on (the weekend of a Mon–Fri flight) doesn't split a run; a
 *   gap with a working weekday in it, or another truck, does.
 * - The market's holds become those runs: one hold per truck and run, with its
 *   dates. Holds are reused (same truck first) and re-dated rather than
 *   replaced, so their history stays; extra runs copy the market's first hold.
 * - LED still scheduling it (fewer truck-days than sold, its last day before
 *   the reservation's): the sold days after LED's last stay held on the trucks
 *   the reservation already had them on, so they aren't freed and no truck is
 *   taken for days LED doesn't run. Later dates are followed.
 * - LED running fewer trucks at once than were sold: that many of the market's
 *   holds on trucks LED doesn't use stay as they are, so the shortfall is still
 *   held and still shows. If there aren't enough such holds the market is left
 *   alone and flagged. LED running more than were sold: mirrored, and flagged.
 * - SOLD DAYS ARE NEVER RELEASED (Andrew, 2026-11-12). The mirror is written
 *   only if what it leaves held still covers every sold truck-day and the
 *   sold trucks at once. Otherwise (LED has scheduled part of the job: a late
 *   start, a gap, days in a market or window this can't read) nothing the
 *   market holds is moved, shortened or removed: LED's days on trucks and days
 *   it doesn't already hold are added, so the booking briefly holds more than
 *   it sold, never less, and is flagged 'partial' until LED covers the sale.
 *   A booking with no quote on file counts every calendar day as sold, so it
 *   stays add-only (flagged) until staff settle it by hand.
 * - What was sold (trucks at once, truck-days) is recorded on the holds the
 *   first time (`features.ledMirror`), so "fully scheduled" is judged against
 *   the sale, not the runs (ledMirrorStandings).
 * - A job number and market on two live bookings: neither is touched; both
 *   are flagged (which booking LED means can't be told).
 * - The days a mirror would newly hold on a truck where LED doesn't run the job
 *   (a weekend inside a run on a new truck) taken by another booking: nothing
 *   is written, and the market is flagged 'clash' naming that booking
 *   (mirrorClashFlags), for as long as the clash lasts.
 * Re-running on a mirrored booking changes nothing. Each booking is written in
 * its own transaction, guarded on its holds being as read.
 */

import { prisma } from '@/lib/prisma'
import { jobKey } from '@/lib/jobNumber'
import { daysSold, ledMarketMatches } from '@/lib/ledJobs'
import { centralDate } from '@/lib/dateOnly'
import { stateCode } from '@/lib/usStates'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'
import { syncOpportunityLedWindow } from '@/lib/sfdcBooking'
import type { Hold, Prisma } from '@prisma/client'
import { clashesWith, lockTrucks, type HoldClashRow } from '@/lib/holdWriteLock'
import { activeHoldWhere } from '@/lib/holdFilters'

/** How far either side of a booking market's dates LED's days of its job are read. */
export const MIRROR_WINDOW_DAYS = 60

/** A won hold as mirroring needs it. Dates YYYY-MM-DD, inclusive. `job_number`: its linked job (linkedJob). */
export type FollowHold = {
  id: string; truck_number: string; start_date: string; end_date: string
  market: string; state: string | null; job_number: string | null
  /** The booking it belongs to (lib/bookings.ts bookingKey). */
  booking: string
  features: string | null
  sfdc_opportunity_id?: string | null
}

/** One LED schedule row: a job on a truck on a day (YYYY-MM-DD), in a market. */
export type FollowRow = {
  truck_number: string; job_number?: string; shift_start: string
  market: string; state?: string; standard_market_name?: string
}

/** One truck's run of LED days: a hold's truck and dates once mirrored. */
export type LedRun = { truck: string; start: string; end: string; days: number }

/** What a booking market was sold, kept on its holds once mirrored. */
export type SoldShape = { trucks: number; truckDays: number }

/**
 * A booking market LED can't be mirrored onto, or can only with a note.
 * 'clash': the mirror would hold days LED doesn't run on a truck another
 * booking holds, so nothing is written (mirrorClashFlags); `blockedBy` names
 * those bookings.
 */
export type MirrorFlag = {
  booking: string; market: string; job: string
  kind: 'reused_job' | 'unfit' | 'more_trucks' | 'partial' | 'clash'
  blockedBy?: string
}

/** The writes that make a booking market match LED. */
export type MirrorPlan = {
  booking: string; market: string; job: string; sold: SoldShape
  /** Holds as read: the write is refused if any has changed since. */
  read: { id: string; truck_number: string; start_date: string; end_date: string }[]
  update: { id: string; from: { truck: string; start: string; end: string }; to: LedRun }[]
  create: { templateId: string; to: LedRun }[]
  remove: string[]
  /** Holds whose features only need the sold shape recorded. */
  stamp: string[]
  /**
   * Days the new holds block on a truck where LED doesn't run the job that
   * day and the market didn't already hold it: the write is refused if
   * another booking holds them (applyLedMirror).
   */
  unrun: { truck: string; start: string; end: string }[]
}

const MULTI_MARKET = /^\s*multi-market\s*:/i
const cityOf = (m: string) => m.split(',')[0].trim().toLowerCase().replace(/\s+/g, ' ')
const marketKey = (m: string) => m.trim().toLowerCase().replace(/\s+/g, ' ')
/** The key a MirrorFlag is looked up by: its booking and market. Pure. */
export const mirrorFlagKey = (booking: string, market: string) => `${booking}|${marketKey(market)}`
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay()
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

/**
 * The cities a Salesforce multi-market label names, each with its state when
 * the label gives one ("Multi-market: Detroit, Los Angeles, CA": Detroit, and
 * Los Angeles in CA). A two-letter state code belongs to the city before it.
 * Pure; exported for tests.
 */
export function labelCities(label: string): { city: string; state: string | null }[] {
  const out: { city: string; state: string | null }[] = []
  for (const part of label.replace(MULTI_MARKET, '').split(',').map(cityOf).filter(Boolean)) {
    const code = part.length === 2 ? stateCode(part) : null
    if (code && out.length && !out[out.length - 1].state) out[out.length - 1].state = code
    else if (!code) out.push({ city: part, state: null })
  }
  return out
}

/**
 * Whether LED's row is in the hold's market. A multi-market label names its
 * cities, so LED's city (its own or its standard market's) must be one of
 * them, in the state the label gives with it, if any; any other hold is
 * compared as one market (ledMarketMatches). Only a two-letter token is read
 * as a state: "New York" and "Washington" are cities in a label, though
 * stateCode reads them as states.
 */
function inHoldMarket(h: { market: string; state: string | null }, r: FollowRow): boolean {
  if (MULTI_MARKET.test(h.market)) {
    // A city the label names, by LED's market or its standard market, each in
    // its own state: LED files a suburb under its metro's standard market, which
    // can be in another state (Jersey City, NJ under New York, NY). A state the
    // label gives must be that market's; one LED doesn't record doesn't refuse.
    const stateAfter = (m: string) => stateCode(m.split(',')[1]?.trim() ?? '')
    const std = r.standard_market_name ?? ''
    const named = [
      { city: cityOf(r.market), state: stateCode(r.state ?? '') || stateAfter(r.market) },
      { city: cityOf(std), state: stateAfter(std) },
    ]
    return labelCities(h.market).some(n => named.some(m => !!m.city && m.city === n.city && (!n.state || !m.state || m.state === n.state)))
  }
  return ledMarketMatches({ market: h.market, state: h.state ?? '' }, { market: r.market, state: r.state ?? '', standard_market_name: r.standard_market_name })
}

/**
 * LED's days grouped by truck into runs. A gap whose days all fall on
 * weekdays the job never runs on (`working`) doesn't split a run. Pure.
 */
export function ledRuns(days: { truck: string; day: string }[]): LedRun[] {
  const working = new Set(days.map(d => weekday(d.day)))
  const byTruck = new Map<string, Set<string>>()
  for (const d of days) {
    const set = byTruck.get(d.truck)
    if (set) set.add(d.day)
    else byTruck.set(d.truck, new Set([d.day]))
  }
  const runs: LedRun[] = []
  for (const [truck, set] of byTruck) {
    const sorted = [...set].sort()
    let run: LedRun = { truck, start: sorted[0], end: sorted[0], days: 1 }
    for (const day of sorted.slice(1)) {
      let gapWorks = false
      for (let g = addDays(run.end, 1); g < day; g = addDays(g, 1)) if (working.has(weekday(g))) { gapWorks = true; break }
      if (gapWorks) {
        runs.push(run)
        run = { truck, start: day, end: day, days: 1 }
      } else {
        run.end = day
        run.days++
      }
    }
    runs.push(run)
  }
  return runs.sort((a, b) => a.start.localeCompare(b.start) || a.truck.localeCompare(b.truck))
}

/**
 * The parts of LED's runs on days their truck isn't already held by the
 * market: each a run of its own, trimmed to start and end on a day LED runs,
 * with `days` the LED days in it. Pure.
 */
function unheldParts(runs: LedRun[], ledDays: Set<string>, held: (truck: string, day: string) => boolean): LedRun[] {
  const out: LedRun[] = []
  for (const r of runs) {
    let cur: LedRun | null = null
    for (let d = r.start; d <= r.end; d = addDays(d, 1)) {
      const runsToday = ledDays.has(`${r.truck}|${d}`)
      if (held(r.truck, d)) { if (cur) out.push(cur); cur = null; continue }
      if (!cur) { if (runsToday) cur = { truck: r.truck, start: d, end: d, days: 1 }; continue }
      if (runsToday) { cur.end = d; cur.days++ }
    }
    if (cur) out.push(cur)
  }
  return out
}

/** Calendar days from start to end, inclusive. Pure. */
const calDays = (start: string, end: string) => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1

/** The most trucks running on any one day. Pure. */
function concurrency(spans: { truck: string; start: string; end: string }[]): number {
  const edges = [...new Set(spans.map(s => s.start))]
  return edges.reduce((max, d) => Math.max(max, new Set(spans.filter(s => s.start <= d && d <= s.end).map(s => s.truck)).size), 0)
}

/** The sold shape recorded on a hold's features, if any. */
export function soldShapeOf(features: string | null): SoldShape | null {
  try {
    const m = (JSON.parse(features ?? '{}') as { ledMirror?: unknown })?.ledMirror as Partial<SoldShape> | undefined
    return m && Number.isInteger(m.trucks) && Number.isInteger(m.truckDays) ? { trucks: m.trucks!, truckDays: m.truckDays! } : null
  } catch {
    return null
  }
}

/**
 * A hold's features once mirrored: its days are LED's days in its run (read
 * back by daysSold while its dates match), with the market's sold shape.
 */
export function mirroredFeatures(features: string | null, run: LedRun | null, sold: SoldShape): string {
  let f: Record<string, unknown> = {}
  try { const p: unknown = JSON.parse(features ?? '{}'); if (p && typeof p === 'object') f = p as Record<string, unknown> } catch { /* unreadable: start fresh */ }
  return JSON.stringify({ ...f, ...(run ? { heldStart: run.start, heldEnd: run.end, heldWorkDays: run.days } : {}), ledMirror: sold })
}

/** The LED read the mirror needs: each job, from MIRROR_WINDOW_DAYS before its holds to as many after (lib/ledJobs.ts ledJobShifts). Pure. */
export function ledMirrorJobs(holds: FollowHold[]): { job: string; start: string; end: string }[] {
  return holds.flatMap(h => {
    const job = jobKey(h.job_number)
    return job ? [{ job, start: addDays(h.start_date, -MIRROR_WINDOW_DAYS), end: addDays(h.end_date, MIRROR_WINDOW_DAYS) }] : []
  })
}

/**
 * The plan when LED doesn't cover the sale yet: every hold stays exactly as
 * it is; LED's days the market doesn't hold yet are added (a gap inside an
 * added run that LED doesn't run, a weekend, is checked against other
 * bookings as `unrun`); holds get the sold shape. Null when nothing changes. Pure.
 */
function addOnlyPlan(a: {
  booking: string; market: string; job: string; sold: SoldShape; g: FollowHold[]; found: LedRun[]
  ledDays: Set<string>; heldBefore: (truck: string, day: string) => boolean
}): MirrorPlan | null {
  const plan: MirrorPlan = {
    booking: a.booking, market: a.market, job: a.job, sold: a.sold,
    read: a.g.map(h => ({ id: h.id, truck_number: h.truck_number, start_date: h.start_date, end_date: h.end_date })),
    update: [], create: [], remove: [], stamp: [], unrun: [],
  }
  for (const add of unheldParts(a.found, a.ledDays, a.heldBefore)) {
    plan.create.push({ templateId: a.g[0].id, to: add })
    for (let d = add.start; d <= add.end; d = addDays(d, 1)) {
      if (a.ledDays.has(`${add.truck}|${d}`)) continue
      const last = plan.unrun[plan.unrun.length - 1]
      if (last && last.truck === add.truck && last.end === addDays(d, -1)) last.end = d
      else plan.unrun.push({ truck: add.truck, start: d, end: d })
    }
  }
  for (const h of a.g) if (!soldShapeOf(h.features)) plan.stamp.push(h.id)
  return plan.create.length || plan.stamp.length ? plan : null
}

/**
 * What to write so each won booking market matches LED, and the markets that
 * can't be (or can only with a note). `holds`: the won holds with a job
 * number; `rows`: LED's days of those jobs near them. Only markets still
 * running (a day today or later) change. Pure.
 */
export function ledMirrorPlans(holds: FollowHold[], rows: FollowRow[], today: string): { plans: MirrorPlan[]; flags: MirrorFlag[] } {
  const groups = new Map<string, FollowHold[]>()
  for (const h of holds) {
    const job = jobKey(h.job_number)
    if (!job) continue
    const key = `${h.booking}|${marketKey(h.market)}|${job}`
    const g = groups.get(key)
    if (g) g.push(h)
    else groups.set(key, [h])
  }
  // A job number and market on two live bookings: which one LED means can't be told.
  const bookingsOf = new Map<string, Set<string>>()
  for (const [key, g] of groups) {
    if (!g.some(h => h.end_date >= today)) continue
    const [booking, market, job] = key.split('|')
    const jm = `${job}|${market}`
    const set = bookingsOf.get(jm)
    if (set) set.add(booking)
    else bookingsOf.set(jm, new Set([booking]))
  }
  const plans: MirrorPlan[] = []
  const flags: MirrorFlag[] = []
  for (const [key, g] of groups) {
    const [booking, , job] = key.split('|')
    const market = g[0].market
    if (!g.some(h => h.end_date >= today)) continue
    if ((bookingsOf.get(`${job}|${marketKey(market)}`)?.size ?? 0) > 1) {
      flags.push({ booking, market, job, kind: 'reused_job' })
      continue
    }
    const from = addDays(g.reduce((m, h) => h.start_date < m ? h.start_date : m, g[0].start_date), -MIRROR_WINDOW_DAYS)
    const to = addDays(g.reduce((m, h) => h.end_date > m ? h.end_date : m, g[0].end_date), MIRROR_WINDOW_DAYS)
    const days = rows
      .filter(r => jobKey(r.job_number) === job && r.shift_start >= from && r.shift_start <= to && inHoldMarket(g[0], r))
      .map(r => ({ truck: r.truck_number, day: r.shift_start }))
    if (!days.length) continue
    const found = ledRuns(days)
    const sold = g.map(h => soldShapeOf(h.features)).find(Boolean) ?? {
      trucks: concurrency(g.map(h => ({ truck: h.truck_number, start: h.start_date, end: h.end_date }))),
      truckDays: g.reduce((n, h) => n + Math.max(daysSold(h.features, h.start_date, h.end_date), 0), 0),
    }
    const ledAtOnce = concurrency(found)
    if (ledAtOnce > sold.trucks) flags.push({ booking, market, job, kind: 'more_trucks' })
    // The sold trucks LED isn't running yet stay held where they are.
    const ledTrucks = new Set(found.map(r => r.truck))
    const spare = g.filter(h => !ledTrucks.has(h.truck_number)).sort((a, b) => a.truck_number.localeCompare(b.truck_number) || a.id.localeCompare(b.id))
    const short = Math.max(0, sold.trucks - ledAtOnce)
    if (spare.length < short) {
      flags.push({ booking, market, job, kind: 'unfit' })
      continue
    }
    const kept = new Set(spare.slice(0, short).map(h => h.id))
    // LED still scheduling it (fewer truck-days than sold, ending before the
    // reservation does): the sold days after LED's last stay held on the trucks
    // the reservation already holds them on (days: 0, none run yet), so they
    // aren't freed and no truck is taken that the booking didn't have.
    // LED's dates later than the reservation's are followed as they are.
    const heldEnd = g.reduce((m, h) => h.end_date > m ? h.end_date : m, g[0].end_date)
    const ledEnd = found.reduce((m, r) => r.end > m ? r.end : m, found[0].end)
    const ledTruckDays = found.reduce((n, r) => n + r.days, 0)
    const remainderOf = ledTruckDays < sold.truckDays && ledEnd < heldEnd
      ? g.filter(h => !kept.has(h.id) && h.end_date > ledEnd)
        .map(h => ({ h, run: { truck: h.truck_number, start: h.start_date > ledEnd ? h.start_date : addDays(ledEnd, 1), end: h.end_date, days: 0 } }))
      : []
    const remainder: LedRun[] = remainderOf.map(x => x.run)
    const runs = [...found, ...remainder].sort((a, b) => a.start.localeCompare(b.start) || a.truck.localeCompare(b.truck))
    let pool = g.filter(h => !kept.has(h.id))
    const plan: MirrorPlan = {
      booking, market, job, sold,
      read: g.map(h => ({ id: h.id, truck_number: h.truck_number, start_date: h.start_date, end_date: h.end_date })),
      update: [], create: [], remove: [], stamp: [], unrun: [],
    }
    const exact = (h: FollowHold, r: LedRun) => h.truck_number === r.truck && h.start_date === r.start && h.end_date === r.end
    const open: LedRun[] = []
    // Already as LED runs it: unchanged (its features only need the sold shape).
    for (const r of runs) {
      const same = pool.find(h => exact(h, r))
      if (!same) { open.push(r); continue }
      pool = pool.filter(h => h !== same)
      if (!soldShapeOf(same.features)) plan.stamp.push(same.id)
    }
    const reuse = (h: FollowHold, r: LedRun) => {
      pool = pool.filter(x => x !== h)
      plan.update.push({ id: h.id, from: { truck: h.truck_number, start: h.start_date, end: h.end_date }, to: r })
    }
    // A hold already on a run's truck is re-dated to it first, so it keeps its
    // truck; then any hold left moves to a run; the runs left are added.
    const rest: LedRun[] = []
    for (const r of open) {
      const same = pool.find(h => h.truck_number === r.truck)
      if (same) reuse(same, r)
      else rest.push(r)
    }
    for (const r of rest) {
      if (pool.length) reuse(pool[0], r)
      else plan.create.push({ templateId: g[0].id, to: r })
    }
    plan.remove = pool.map(h => h.id)
    // Days a hold will now block on a truck that LED doesn't run the job on
    // that day and the market didn't already hold there (the weekend inside a
    // run on a new truck): checked against other bookings when written.
    const ledDays = new Set(days.map(d => `${d.truck}|${d.day}`))
    const heldBefore = (truck: string, day: string) => g.some(h => h.truck_number === truck && h.start_date <= day && day <= h.end_date)
    for (const to of [...plan.update.map(u => u.to), ...plan.create.map(c => c.to)]) {
      let open: { truck: string; start: string; end: string } | null = null
      for (let d = to.start; d <= to.end; d = addDays(d, 1)) {
        const unrun = !ledDays.has(`${to.truck}|${d}`) && !heldBefore(to.truck, d)
        if (unrun && open && open.end === addDays(d, -1)) open.end = d
        else if (unrun) { open = { truck: to.truck, start: d, end: d }; plan.unrun.push(open) }
      }
    }
    for (const id of kept) if (!soldShapeOf(g.find(h => h.id === id)!.features)) plan.stamp.push(id)
    // SOLD DAYS ARE NEVER RELEASED: what the exact mirror would leave held is
    // LED's days, the kept holds' sold days, and the held tail's share of its
    // hold's sold days (rounded down). Short of the sale, it isn't written.
    const keptHolds = g.filter(h => kept.has(h.id))
    const heldAfter = ledTruckDays
      + keptHolds.reduce((n, h) => n + Math.max(daysSold(h.features, h.start_date, h.end_date), 0), 0)
      + remainderOf.reduce((n, { h, run }) => n + Math.floor(Math.max(daysSold(h.features, h.start_date, h.end_date), 0) * calDays(run.start, run.end) / calDays(h.start_date, h.end_date)), 0)
    const atOnceAfter = concurrency([...runs, ...keptHolds.map(h => ({ truck: h.truck_number, start: h.start_date, end: h.end_date }))])
    if (heldAfter < sold.truckDays || atOnceAfter < sold.trucks) {
      flags.push({ booking, market, job, kind: 'partial' })
      const add = addOnlyPlan({ booking, market, job, sold, g, found, ledDays, heldBefore })
      if (add) plans.push(add)
      continue
    }
    if (plan.update.length || plan.create.length || plan.remove.length || plan.stamp.length) plans.push(plan)
  }
  return { plans, flags }
}

/**
 * Per won booking market that has been mirrored: LED's truck-days on its
 * holds against what was sold (`features.ledMirror`), so splitting a hold into
 * runs never makes a short booking look fully scheduled. Each hold's `of` is
 * its share, the market's sold truck-days in total; `scheduled` is the
 * market's. Holds never mirrored keep their own standing. Pure.
 */
export function ledMirrorStandings<S extends { days: number; of: number; scheduled: boolean }>(
  holds: { id: string; booking: string; market: string; features: string | null }[],
  standings: Map<string, S>,
): Map<string, S> {
  const out = new Map(standings)
  const groups = new Map<string, { id: string; sold: SoldShape }[]>()
  for (const h of holds) {
    const sold = soldShapeOf(h.features)
    if (!sold || !standings.has(h.id)) continue
    const key = `${h.booking}|${marketKey(h.market)}`
    const g = groups.get(key)
    if (g) g.push({ id: h.id, sold })
    else groups.set(key, [{ id: h.id, sold }])
  }
  for (const g of groups.values()) {
    const sold = g[0].sold.truckDays
    const days = g.reduce((n, h) => n + standings.get(h.id)!.days, 0)
    let left = sold
    g.forEach((h, i) => {
      const s = standings.get(h.id)!
      const of = i === g.length - 1 ? Math.max(left, 0) : Math.min(s.days, Math.max(left, 0))
      left -= of
      out.set(h.id, { ...s, of, scheduled: days >= sold })
    })
  }
  return out
}

type ClashHold = { id: string; truck_number: string; start_date: Date; end_date: Date; client_name: string; status: string }
type HoldReader = Pick<Prisma.TransactionClient, 'hold'>

/** Live holds on the plans' unrun trucks and dates (AT&T soft holds give way, as in the sweep's own conflict check). */
async function liveOnUnrun(db: HoldReader, plans: MirrorPlan[]): Promise<ClashHold[]> {
  const unrun = plans.flatMap(p => p.unrun)
  if (!unrun.length) return []
  const from = unrun.map(u => u.start).sort()[0]
  const to = unrun.map(u => u.end).sort().reverse()[0]
  return db.hold.findMany({
    where: {
      truck_number: { in: [...new Set(unrun.map(u => u.truck))] },
      ...activeHoldWhere({ excludeAttSoft: true }),
      start_date: { lte: new Date(`${to}T23:59:59.999Z`) },
      end_date: { gte: new Date(from) },
    },
    select: { id: true, truck_number: true, start_date: true, end_date: true, client_name: true, status: true },
  })
}

/** The other bookings' holds on a plan's unrun days (its own holds don't count). Pure; exported for tests. */
export function planClashes(p: MirrorPlan, live: ClashHold[]): HoldClashRow[] {
  return clashesWith(p.unrun, live, new Set(p.read.map(r => r.id)))
}

/** The 'clash' flag a refused plan carries, naming what blocks it. Pure; exported for tests. */
export function clashFlag(p: MirrorPlan, clashes: HoldClashRow[]): MirrorFlag {
  const blockedBy = [...new Set(clashes.map(c => `${c.client} (truck ${c.truck}, ${c.start} to ${c.end})`))].join('; ')
  return { booking: p.booking, market: p.market, job: p.job, kind: 'clash', blockedBy }
}

/**
 * The plans applyLedMirror would refuse right now because another booking
 * holds one of their unrun days, as 'clash' flags. Read-only, one query for
 * all plans. Reservations runs it on every load, so the flag shows for as long
 * as the clash lasts and goes once it clears or the mirror is written.
 */
export async function mirrorClashFlags(plans: MirrorPlan[], db: HoldReader = prisma): Promise<MirrorFlag[]> {
  const withUnrun = plans.filter(p => p.unrun.length)
  if (!withUnrun.length) return []
  const live = await liveOnUnrun(db, withUnrun)
  return withUnrun.flatMap(p => { const c = planClashes(p, live); return c.length ? [clashFlag(p, c)] : [] })
}

/** A booking's mirror, as written. */
export type MirrorDone = {
  booking: string; opportunity: string | null; by: string
  updated: { id: string; from: { truck: string; start: string; end: string }; to: LedRun }[]
  created: { id: string; templateId: string; to: LedRun }[]
  removed: string[]
}

/**
 * Writes each plan, one booking market per transaction: re-dates or moves the
 * holds, adds the extra runs as holds copied from the market's first hold,
 * removes holds no run needs, and records the sold shape on every hold. Each
 * change is audited (SWAP_HOLD_TRUCK with reason led_truck_follow for a hold
 * re-dated or moved; LED_MIRROR_ADD / LED_MIRROR_REMOVE). Refused, with
 * nothing written, when any of the market's holds changed since it was read
 * (a staff swap or un-commit meanwhile wins). Marks the holds for the
 * Salesforce LED Trucks sync (syncFollowedOpportunities).
 *
 * MIRROR PATH — the days LED runs are written whatever they clash with: LED
 * already runs the job there, and refusing would leave the app holding what
 * LED isn't running and hide the real clash (it surfaces as a conflict and on
 * /api/holds/infeasible). Days LED doesn't run on a truck (a weekend inside a
 * run, on a truck the market didn't hold) are checked under the same truck
 * locks as every booking (lib/holdWriteLock.ts lockTrucks): if another
 * booking holds one, nothing is written, Reservations flags the market
 * 'clash' (mirrorClashFlags) and the next sweep tries again. One
 * failed booking never stops the rest.
 */
export async function applyLedMirror(plans: MirrorPlan[], templates: Map<string, Hold>): Promise<MirrorDone[]> {
  if (!plans.length) return []
  const serviceUser = await prisma.user.findUnique({ where: { email: SFDC_SERVICE_USER_EMAIL }, select: { id: true } })
  const done: MirrorDone[] = []
  for (const p of plans) {
    const template = templates.get(p.read[0]?.id ?? '') ?? templates.get(p.create[0]?.templateId ?? '')
    if (!template) continue
    const by = serviceUser?.id ?? template.created_by
    const opportunity = template.sfdc_opportunity_id
    const pending = opportunity ? { led_follow_sync_pending: new Date() } : {}
    const date = (d: string) => new Date(`${d}T00:00:00Z`)
    try {
      const result = await prisma.$transaction(async (tx) => {
        // The same truck locks every booking path takes (lib/holdWriteLock.ts),
        // so a booking of these trucks can't land between the check and the write.
        await lockTrucks(tx, [...p.read.map(r => r.truck_number), ...p.update.map(u => u.to.truck), ...p.create.map(c => c.to.truck)])
        // Days LED doesn't run on a truck aren't mirrored: another booking
        // holding one of them keeps it, and this market waits (logged).
        if (p.unrun.length) {
          const clashes = planClashes(p, await liveOnUnrun(tx, [p]))
          if (clashes.length) throw new MirrorClash(clashes.map(c => `${c.truck} ${c.start}–${c.end}`).join(', '))
        }
        // Every hold of the market still as read, or nothing is written.
        for (const r of p.read) {
          const still = await tx.hold.count({ where: { id: r.id, truck_number: r.truck_number, start_date: date(r.start_date), end_date: date(r.end_date), status: 'COMMITTED' } })
          if (!still) throw new StaleMirror()
        }
        const featuresOf = new Map(p.read.map(r => [r.id, templates.get(r.id)?.features ?? null]))
        for (const u of p.update) {
          await tx.hold.update({
            where: { id: u.id },
            data: { truck_number: u.to.truck, start_date: date(u.to.start), end_date: date(u.to.end), features: mirroredFeatures(featuresOf.get(u.id) ?? null, u.to, p.sold), ...pending },
          })
          await tx.auditLog.create({ data: {
            action: 'SWAP_HOLD_TRUCK', truck_number: u.to.truck, user_id: by, hold_id: u.id,
            details: JSON.stringify({ old_truck: u.from.truck, new_truck: u.to.truck, old_start: u.from.start, old_end: u.from.end, new_start: u.to.start, new_end: u.to.end, reason: 'led_truck_follow', job_number: p.job }),
          } })
        }
        const created: { id: string; templateId: string; to: LedRun }[] = []
        for (const c of p.create) {
          const t = templates.get(c.templateId) ?? template
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { id: _id, created_at: _c, updated_at: _u, ...copy } = t
          const row = await tx.hold.create({
            data: { ...copy, truck_number: c.to.truck, start_date: date(c.to.start), end_date: date(c.to.end), features: mirroredFeatures(t.features, c.to, p.sold), ...pending },
          })
          created.push({ id: row.id, templateId: t.id, to: c.to })
          await tx.auditLog.create({ data: {
            action: 'LED_MIRROR_ADD', truck_number: c.to.truck, user_id: by, hold_id: row.id,
            details: JSON.stringify({ copied_from: t.id, start: c.to.start, end: c.to.end, reason: 'led_truck_follow', job_number: p.job }),
          } })
        }
        for (const id of p.remove) {
          const was = p.read.find(r => r.id === id)!
          await tx.auditLog.create({ data: {
            action: 'LED_MIRROR_REMOVE', truck_number: was.truck_number, user_id: by, hold_id: id,
            details: JSON.stringify({ ...was, reason: 'led_truck_follow', job_number: p.job }),
          } })
          await tx.hold.delete({ where: { id } })
        }
        for (const id of p.stamp) {
          await tx.hold.update({ where: { id }, data: { features: mirroredFeatures(featuresOf.get(id) ?? null, null, p.sold) } })
        }
        return created
      }, { maxWait: 10_000, timeout: 45_000 })
      done.push({ booking: p.booking, opportunity, by, updated: p.update, created: result, removed: p.remove })
      if (p.update.length || p.create.length || p.remove.length) {
        console.log(`[led-follow] booking ${p.booking} (job ${p.job}, ${p.market}) mirrored to LED: ${p.update.length} re-dated or moved, ${p.create.length} added, ${p.remove.length} removed`)
      }
    } catch (err) {
      if (err instanceof StaleMirror) console.warn(`[led-follow] booking ${p.booking} changed while mirroring; next sweep`)
      else if (err instanceof MirrorClash) console.warn(`[led-follow] booking ${p.booking} not mirrored: days LED doesn't run would take another booking's truck (${err.message}); flagged 'clash' on Reservations, next sweep`)
      else console.error(`[led-follow] mirroring booking ${p.booking} failed; carrying on:`, err)
    }
  }
  return done
}

class StaleMirror extends Error {}
class MirrorClash extends Error {}

/**
 * How long a refused LED Trucks sync waits before Reservations flags the
 * booking (app/hold-requests): a few sweeps' grace for a passing error.
 */
export const FOLLOW_SYNC_OVERDUE_MS = 3600_000

/**
 * Syncs LED Trucks to Salesforce for the opportunities of holds moved this
 * sweep, and of committed holds moved earlier whose sync hasn't succeeded yet
 * (led_follow_sync_pending), and clears the mark once Salesforce has taken
 * it. A failure stays marked and is retried every sweep for as long as the
 * hold is committed and its campaign running: one Salesforce refuses for good
 * (deleted, a validation rule) is never dropped silently. Past
 * FOLLOW_SYNC_OVERDUE_MS, Reservations shows it on the booking's card, so
 * staff fix it in Salesforce. A hold no longer committed isn't retried here:
 * every release path syncs on its own.
 * Clearing only touches the marks read just before the sync ran, unchanged,
 * so a move made meanwhile stays marked. Returns the opportunities still waiting. Never throws.
 */
export async function syncFollowedOpportunities(justMoved: string[]): Promise<string[]> {
  const now = new Date()
  // Only holds still running: once a campaign has ended, its LED Trucks no
  // longer decides anything, so its mark is dropped below rather than retried.
  const today = new Date(centralDate(now) + 'T00:00:00Z')
  const marked = (await prisma.hold.findMany({
    where:  { led_follow_sync_pending: { not: null }, status: 'COMMITTED', sfdc_opportunity_id: { not: null }, end_date: { gte: today } },
    select: { id: true, sfdc_opportunity_id: true, led_follow_sync_pending: true },
  }).catch((err) => {
    console.error('[led-follow] reading holds waiting for a Salesforce sync failed:', err)
    return []
  }))
  // A hold no longer committed drops its mark: its release synced on its own,
  // and a mark left behind would be taken for a refused sync if it's won again.
  // Likewise a hold with no opportunity left (nothing in Salesforce to sync), or
  // whose campaign has ended.
  await prisma.hold.updateMany({ where: { led_follow_sync_pending: { not: null }, OR: [{ status: { not: 'COMMITTED' } }, { sfdc_opportunity_id: null }, { end_date: { lt: today } }] }, data: { led_follow_sync_pending: null } })
    .catch((err) => console.error('[led-follow] clearing sync marks on holds no longer committed failed:', err))
  const retry = marked.map(h => h.sfdc_opportunity_id).filter((id): id is string => !!id)
  const pending: string[] = []
  for (const opp of new Set([...justMoved, ...retry])) {
    // The marks this sync covers: read before it runs, and cleared only if
    // unchanged after, so a move committed meanwhile (another sweep's) keeps
    // its mark for the next sweep.
    const covered = await prisma.hold.findMany({
      where:  { sfdc_opportunity_id: opp, led_follow_sync_pending: { not: null } },
      select: { id: true, led_follow_sync_pending: true },
    }).catch(() => [])
    const warning = await syncOpportunityLedWindow(opp)
    if (warning) {
      console.warn(`[led-follow] ${opp}: ${warning} Retrying next sweep.`)
      pending.push(opp)
      continue
    }
    for (const h of covered) {
      await prisma.hold.updateMany({ where: { id: h.id, led_follow_sync_pending: h.led_follow_sync_pending }, data: { led_follow_sync_pending: null } })
        .catch((err) => console.error(`[led-follow] clearing the sync mark on hold ${h.id} failed:`, err))
    }
  }
  return pending
}

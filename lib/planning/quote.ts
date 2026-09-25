/**
 * Multi-market quote: the order router plus the same pricing as the
 * single-market LED quote.
 *
 * Each market is priced on its own, exactly as a single-market quote would
 * price it. Transport follows the existing rules per move: the legs that
 * arrive at a market are priced against that market's activation days and
 * lead time — free inside the service area, absorbed when the market clears
 * both absorption tests, billed otherwise.
 *
 * Then the engine is rerun on a few variations to suggest alternatives:
 * markets we cannot do, fewer trucks, a different hours model, a cheaper
 * start. Every figure comes from the same engine and pricing.
 */

import {
  computeQuote, priceTransport,
  resolveCampaignCoords, resolveMarketSizeTierId, businessDaysBetween,
} from '@/lib/pricing'
import { countCalendarDays } from '@/lib/pricing/schedule'
import { resolveDefaultRateOverrides, resolveRateOverridesBySfdcAccount, resolveMarketInputAll } from '@/lib/pricing/resolvers'
import type { RateOverrides } from '@/lib/pricing/config'
import { canonicalMarketName, loadStandardMarketCoords, titleCaseMarket } from '@/lib/marketBounds'
import { haversineDistance } from '@/lib/marketCoordinates'
import { DEFAULT_RULES, loadPlanningFleet, type ReservedTruck } from './fleet'
import {
  DEFAULT_ENGINE, planOrder, legsByLine, trucksByLine, lineActivationDays, deliveredTruckDays, SCHEDULES,
  type EngineSettings, type OrderLine, type OrderPlan, type Shortfall,
} from './order'
import { addDays, type PlanTruck } from './planner'

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type QuoteRow = {
  id: string
  market: string
  /** Set for rows that came from an uploaded ZIP list: the area's own centre. */
  lat?: number
  lng?: number
  startDate: string
  endDate: string
  trucks: number
  daysPerWeek: number
  hours: number
}

export type QuoteRequest = {
  rows: QuoteRow[]
  sfdcAccountId?: string
  features: { shadowFencing: boolean; smartDirectional: boolean; deviceId: boolean }
  reserveSoftHolds?: boolean
  alloyRenews?: boolean
  hopLimitRoadMiles?: number
}

export type RowError = { rowId: string; message: string; candidates?: string[] }

/** The canonical name of the standard market nearest a point, or null when none are loaded. */
async function nearestStandardMarket(lat: number, lng: number): Promise<string | null> {
  const coords = await loadStandardMarketCoords()
  let best: { key: string; miles: number } | null = null
  for (const [key, c] of coords) {
    const miles = haversineDistance(lat, lng, c.lat, c.lng)
    if (!best || miles < best.miles) best = { key, miles }
  }
  if (!best) return null
  return (await canonicalMarketName(best.key)) ?? titleCaseMarket(best.key)
}

/** Hop limits the engine accepts, whatever a request asks for. */
export const HOP_LIMIT_RANGE = { min: 50, max: 450 }

/** Shape and range checks for a quote request; null when it is valid. */
export function validateQuoteRequest(body: QuoteRequest): string | null {
  if (!Array.isArray(body.rows) || body.rows.length === 0) return 'Add at least one market.'
  if (body.rows.length > 200) return 'Up to 200 markets per quote.'
  const isDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  for (const r of body.rows) {
    if (typeof r.id !== 'string' || typeof r.market !== 'string') return 'Each row needs an id and a market.'
    if (!isDate(r.startDate) || !isDate(r.endDate)) return `Dates are missing for ${r.market || 'a row'}.`
    if (!Number.isInteger(r.trucks) || r.trucks < 1 || r.trucks > 50) return `Trucks for ${r.market} must be 1 to 50.`
    if (!(SCHEDULES as readonly number[]).includes(r.daysPerWeek)) return `Schedule for ${r.market} must be Mon-Fri, Mon-Sat, 7 days or 3 days a week.`
    if (!(r.hours >= 8 && r.hours <= 12)) return `Hours for ${r.market} must be 8 to 12.`
  }
  const today = new Date().toISOString().split('T')[0]
  if (body.rows.some(r => r.endDate < today)) return 'Every market must end today or later.'
  return null
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type LineQuote = {
  id: string
  market: string
  startDate: string
  endDate: string
  trucks: number
  daysPerWeek: number
  hours: number
  /** Days per truck the client asked for (the schedule over the date range). */
  activationDays: number
  calendarDays: number
  /** Truck-days billed: the days the plan's trucks actually work here, plus requested days for any truck not covered. */
  truckDays: number
  dailyRate: number
  hourSurcharge: number
  effectiveDailyRate: number
  shadowFencingFloored: boolean
  baseMedia: number
  shadowFencing: number
  smartDirectional: number
  deviceId: number
  media: number
  transport: { outcome: 'INCLUDED' | 'ABSORBED' | 'BILLED'; billed: number; absorbedCost: number }
  /** Why transport is included, when it is absorbed. */
  transportNote: string | null
  total: number
  assigned: { truckNumber: string; sharedWith: string | null; hopRoadMiles: number }[]
  /** Where each assigned truck comes from to reach this market, as the single-market quote shows it. */
  arrivals: Arrival[]
  missing: number
}

export type Arrival = {
  truckNumber: string
  /** Market or place the truck drives from. */
  from: string
  fromKind: 'PRIOR_JOB' | 'GPS' | 'THIS_ORDER' | 'SHARED'
  miles: number
  transportDays: number
  /** Beyond the service area: a repositioning move, billed or absorbed per §6. */
  outOfMarket: boolean
  /** Charged to the client for this move (BILLED only). */
  charge: number
  /** What we absorb for this move (ABSORBED only). */
  ourCost: number
}

export type Itinerary = {
  truckNumber: string
  drivers: number
  stops: { markets: string[]; start: string; end: string; hopRoadMiles: number }[]
  moves: { from: string; to: string; miles: number; transportDays: number }[]
}

export type Alternative = {
  kind: 'CANT_DO' | 'FEWER_TRUCKS' | 'HOURS_MODEL' | 'START_DATE'
  text: string
}

export type QuoteSummary = {
  trucksUsed: number
  drivers: number
  markets: number
  media: number
  transportBilled: number
  transportAbsorbed: number
  grandTotal: number
  deadheadMiles: number
  poolSize: number
  leftForOthers: number
}

export type MultiMarketQuote = {
  lines: LineQuote[]
  summary: QuoteSummary
  itineraries: Itinerary[]
  alternatives: Alternative[]
  reserved: ReservedTruck[]
  pricingBasis: string
  warnings: string[]
}

// ---------------------------------------------------------------------------

const EXCLUDED_STATES = new Set(['AK', 'HI'])

/**
 * What the single-market quote bills a range of 6 days or fewer on: the page
 * (app/quote/page.tsx) always sends days_per_week, and for short ranges that
 * is its hidden default of 5. Kept identical so the same campaign prices the
 * same on both tabs; change both together.
 */
export const SHORT_RANGE_DAYS_PER_WEEK = 5

export async function resolveRows(rows: QuoteRow[]): Promise<{ lines: OrderLine[]; errors: RowError[] }> {
  const lines: OrderLine[] = []
  const errors: RowError[] = []
  for (const r of rows) {
    if (!r.market.trim()) { errors.push({ rowId: r.id, message: 'Market is required.' }); continue }
    if (!(r.startDate && r.endDate && r.endDate >= r.startDate)) { errors.push({ rowId: r.id, message: 'Start and end dates are required, end on or after start.' }); continue }
    if (!(r.trucks >= 1)) { errors.push({ rowId: r.id, message: 'At least one truck.' }); continue }

    let market = r.market.trim()
    let lat = r.lat
    let lng = r.lng
    let standardMarket: string | undefined
    if (lat !== undefined && lng !== undefined) {
      // An imported DMA is not a standard market name. Book it under the
      // nearest standard market so its holds resolve to a place later.
      standardMarket = (await nearestStandardMarket(lat, lng)) ?? undefined
    } else {
      const matches = await resolveMarketInputAll(market)
      if (matches.length === 0) { errors.push({ rowId: r.id, message: `"${market}" was not found. Include the state, e.g. "Portland, OR".` }); continue }
      if (matches.length > 1) { errors.push({ rowId: r.id, message: `Several markets match "${market}".`, candidates: matches.map(m => m.formal) }); continue }
      market = matches[0].formal
      const coords = await resolveCampaignCoords(market)
      if (!coords) { errors.push({ rowId: r.id, message: `Could not locate ${market}.` }); continue }
      lat = coords.lat
      lng = coords.lng
    }
    const st = (standardMarket ?? market).split(',').pop()?.trim().toUpperCase()
    if (st && EXCLUDED_STATES.has(st)) { errors.push({ rowId: r.id, message: `${market} is outside the contiguous 48 states.` }); continue }
    // Priced exactly as the single-market quote prices it: for a range of 6
    // days or fewer that page hides its schedule buttons and sends its
    // default, Mon-Fri, so a short range bills its weekdays.
    const daysPerWeek = countCalendarDays(r.startDate, r.endDate) <= 6 ? SHORT_RANGE_DAYS_PER_WEEK : r.daysPerWeek
    lines.push({ id: r.id, market, lat, lng, startDate: r.startDate, endDate: r.endDate, trucks: Math.floor(r.trucks), daysPerWeek, hours: r.hours, standardMarket })
  }
  return { lines, errors }
}

async function rateOverridesFor(sfdcAccountId?: string): Promise<{ overrides: RateOverrides | null; basis: string }> {
  let overrides: RateOverrides | null = await resolveDefaultRateOverrides()
  let basis = 'standard'
  if (sfdcAccountId) {
    const r = await resolveRateOverridesBySfdcAccount(sfdcAccountId)
    if (r.overrides) {
      overrides = { ...overrides, ...r.overrides, daily_rates: { ...overrides?.daily_rates, ...r.overrides.daily_rates } }
      if (r.agreementName) basis = `agreement: ${r.agreementName}`
    }
  }
  return { overrides, basis }
}

/** Price every line on its own, with transport for the legs that arrive at it. */
async function priceLines(
  lines: OrderLine[],
  plan: OrderPlan,
  features: QuoteRequest['features'],
  overrides: RateOverrides | null,
  tiers: Map<string, number>,
): Promise<LineQuote[]> {
  const legs = legsByLine(plan)
  const trucks = trucksByLine(plan)
  const delivered = deliveredTruckDays(plan)
  const missing = new Map(plan.shortfalls.map(s => [s.lineId, s.missing]))
  return lines.map(line => {
    const activationDays = lineActivationDays(line)
    // Bill what the trucks actually work here. A shared truck's rotation can
    // give a market a different number of days in a part week than a truck of
    // its own would, so the request's days x trucks is not the bill. Trucks
    // the fleet cannot cover are quoted at the requested days.
    const truckDays = Math.max(1, (delivered.get(line.id) ?? 0) + (missing.get(line.id) ?? 0) * activationDays)
    // The rate depends only on total truck-days (the lower of the per-truck
    // and cumulative tiers is always the cumulative one), so one truck for
    // truckDays prices exactly as N trucks sharing them.
    const q = computeQuote({
      truckCount: 1,
      days: truckDays,
      operatingHours: line.hours,
      marketSizeTierId: tiers.get(line.market) ?? 3,
      includeSmartDirectional: features.smartDirectional,
      includeDeviceId: features.deviceId,
      rateOverrides: overrides,
    })
    const sf = features.shadowFencing ? q.better.shadowFencing : 0
    const sd = features.smartDirectional ? q.better.smartDirectional : 0
    const did = features.deviceId ? q.better.deviceId : 0
    const media = q.good.baseMedia + sf + sd + did

    const lineLegs = legs.get(line.id) ?? []
    const t = priceTransport({
      activationDays,
      leadBusinessDays: businessDaysBetween(new Date(), new Date(line.startDate + 'T00:00:00Z')),
      legs: lineLegs.map(l => ({ distanceMiles: l.distanceMiles, needsRepositioning: l.transportDays > 0, truckNumber: l.truckNumber, fromMarket: l.fromLabel })),
      transportIncluded: overrides?.transport_included,
      overrides: { dayRate: overrides?.transport_day_rate, airfare: overrides?.transport_airfare, hotelPerNight: overrides?.transport_hotel_per_night },
    })
    const absorbedCost = t.outcome === 'ABSORBED' ? Math.round(lineLegs.reduce((s, l) => s + l.absorbedCost, 0)) : 0

    // Per truck: the move that brings it here, at the charge priceTransport
    // gave it. A truck shared with another market reaches this one by the
    // weekly hop.
    const legCharge = new Map(t.legs.map(l => [l.truckNumber, l.charge]))
    const assigned = trucks.get(line.id) ?? []
    const arrivals: Arrival[] = assigned.map(a => {
      const leg = lineLegs.find(l => l.truckNumber === a.truckNumber)
      if (!leg) {
        return { truckNumber: a.truckNumber, from: a.sharedWith ?? '', fromKind: 'SHARED', miles: a.hopRoadMiles, transportDays: 0, outOfMarket: false, charge: 0, ourCost: 0 }
      }
      const out = leg.transportDays > 0
      return {
        truckNumber: a.truckNumber, from: leg.fromLabel, fromKind: leg.fromKind,
        miles: Math.round(leg.distanceMiles), transportDays: leg.transportDays, outOfMarket: out,
        charge: out && t.outcome === 'BILLED' ? Math.round(legCharge.get(leg.truckNumber) ?? 0) : 0,
        ourCost: out && t.outcome === 'ABSORBED' ? Math.round(leg.absorbedCost) : 0,
      }
    })

    return {
      id: line.id, market: line.market, startDate: line.startDate, endDate: line.endDate,
      trucks: line.trucks, daysPerWeek: line.daysPerWeek, hours: line.hours,
      activationDays, calendarDays: countCalendarDays(line.startDate, line.endDate), truckDays,
      dailyRate: q.dailyRate, hourSurcharge: q.hourSurcharge, effectiveDailyRate: q.effectiveDailyRate,
      shadowFencingFloored: features.shadowFencing && q.better.shadowFencingFloored,
      baseMedia: Math.round(q.good.baseMedia), shadowFencing: Math.round(sf), smartDirectional: Math.round(sd), deviceId: Math.round(did),
      media: Math.round(media),
      transport: { outcome: t.outcome, billed: Math.round(t.charge), absorbedCost },
      total: Math.round(media + t.charge),
      assigned,
      arrivals,
      transportNote: t.absorbedReason ?? null,
      missing: missing.get(line.id) ?? 0,
    }
  })
}

function summarize(lines: LineQuote[], plan: OrderPlan): QuoteSummary {
  const media = lines.reduce((s, l) => s + l.media, 0)
  const billed = lines.reduce((s, l) => s + l.transport.billed, 0)
  return {
    trucksUsed: plan.trucks.length,
    drivers: plan.trucks.reduce((s, t) => s + t.drivers, 0),
    markets: lines.length,
    media,
    transportBilled: billed,
    transportAbsorbed: lines.reduce((s, l) => s + l.transport.absorbedCost, 0),
    grandTotal: media + billed,
    deadheadMiles: Math.round(plan.trucks.reduce((s, t) => s + t.legs.reduce((a, l) => a + l.distanceMiles, 0), 0)),
    poolSize: plan.poolSize,
    leftForOthers: plan.poolSize - plan.trucks.length,
  }
}

function itineraries(plan: OrderPlan): Itinerary[] {
  const name = (id: string) => plan.trucks.flatMap(t => t.jobs.flatMap(j => j.lines)).find(l => l.id === id)?.market ?? id
  return plan.trucks.map(t => ({
    truckNumber: t.truckNumber,
    drivers: t.drivers,
    stops: t.jobs.map(j => ({ markets: j.lines.map(l => l.market), start: j.start, end: j.end, hopRoadMiles: j.hopRoadMiles })),
    moves: t.legs.map(l => ({ from: l.fromLabel, to: name(l.toLineId), miles: l.distanceMiles, transportDays: l.transportDays })),
  }))
}

/** Later starts tried when markets are short; the fleet is loaded far enough out to see them. */
const START_SHIFTS = [7, 14, 21, 28, 35, 42]

const money = (n: number) => '$' + Math.round(Math.abs(n)).toLocaleString('en-US')
const fmt = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

// ---------------------------------------------------------------------------

export type PreparedQuote = {
  quote: MultiMarketQuote
  lines: OrderLine[]
  plan: OrderPlan
}

export async function buildMultiMarketQuote(req: QuoteRequest, lines: OrderLine[], opts: { alternatives?: boolean } = {}): Promise<PreparedQuote> {
  const today = new Date().toISOString().split('T')[0]
  const planThrough = lines.reduce((m, l) => (l.endDate > m ? l.endDate : m), today)
  const rules = {
    ...DEFAULT_RULES,
    reserveSoftHolds: req.reserveSoftHolds ?? DEFAULT_RULES.reserveSoftHolds,
    renewingPrograms: req.alloyRenews ? ['Alloy Build'] : [],
  }
  const { overrides, basis } = await rateOverridesFor(req.sfdcAccountId)
  const s: EngineSettings = {
    ...DEFAULT_ENGINE,
    today,
    hopLimitRoadMiles: Math.min(HOP_LIMIT_RANGE.max, Math.max(HOP_LIMIT_RANGE.min, Number(req.hopLimitRoadMiles) || DEFAULT_ENGINE.hopLimitRoadMiles)),
    serviceAreaMiles: overrides?.service_area_miles,
  }
  // Load far enough out that the cheaper-start alternatives see the fleet too.
  const fleet = await loadPlanningFleet({ today, planThrough: addDays(planThrough, START_SHIFTS[START_SHIFTS.length - 1]), rules })
  const tiers = new Map<string, number>()
  for (const l of lines) if (!tiers.has(l.market)) tiers.set(l.market, await resolveMarketSizeTierId(l.standardMarket ?? l.market))

  const run = (ls: OrderLine[], settings = s) => planOrder(ls, fleet.trucks, settings)
  const plan = run(lines)
  const priced = await priceLines(lines, plan, req.features, overrides, tiers)
  const summary = summarize(priced, plan)

  const alternatives = opts.alternatives === false ? [] : await buildAlternatives(lines, plan, summary, { run, price: (ls, p) => priceLines(ls, p, req.features, overrides, tiers), s, trucks: fleet.trucks })

  const warnings: string[] = []
  if (plan.approximateClusters > 0) warnings.push('Some markets were too many to pair exactly in the time allowed. The truck count is still the minimum, but the weekly hops may not be the shortest possible.')
  if (fleet.trucks.some(t => !t.gps)) warnings.push(`${fleet.trucks.filter(t => !t.gps).length} truck(s) have no live position and were only considered where a scheduled job shows where they will be.`)
  if (rules.reserveSoftHolds && !fleet.reserved.some(r => r.reason.startsWith('AT&T soft'))) warnings.push('No AT&T soft holds are on file, so no AT&T trucks are held back.')
  if (req.alloyRenews && !fleet.reserved.some(r => !r.reason.startsWith('AT&T soft'))) warnings.push('Alloy Build is marked as renewing, but no truck is currently on an Alloy Build job.')
  for (const l of priced) {
    const asked = l.trucks * l.activationDays
    if (l.truckDays < asked && l.assigned.some(a => a.sharedWith)) {
      warnings.push(`${l.market} gets ${l.truckDays} of the ${asked} truck-days asked for, and is billed for ${l.truckDays}: its truck alternates with ${l.assigned.find(a => a.sharedWith)!.sharedWith}, and the final part-week goes to that market. A truck of its own would cover every day.`)
    }
    const lead = businessDaysBetween(new Date(), new Date(l.startDate + 'T00:00:00Z'))
    if (l.transport.outcome === 'BILLED' && lead < 10) warnings.push(`${l.market} starts ${lead} business days out, so its transport is billed rather than absorbed.`)
  }

  return {
    quote: { lines: priced, summary, itineraries: itineraries(plan), alternatives, reserved: fleet.reserved, pricingBasis: basis, warnings },
    lines,
    plan,
  }
}

async function buildAlternatives(
  lines: OrderLine[],
  plan: OrderPlan,
  base: QuoteSummary,
  ctx: {
    run: (ls: OrderLine[], s?: EngineSettings) => OrderPlan
    price: (ls: OrderLine[], p: OrderPlan) => Promise<LineQuote[]>
    s: EngineSettings
    trucks: PlanTruck[]
  },
): Promise<Alternative[]> {
  const out: Alternative[] = []
  const cost = (sum: QuoteSummary) => sum.transportBilled + sum.transportAbsorbed

  const short = (p: OrderPlan) => p.shortfalls.reduce((n, x) => n + x.missing, 0)

  // Markets we cannot do. A few are named one by one; many become one line.
  const sfs = plan.shortfalls as Shortfall[]
  if (sfs.length > 0 && sfs.length <= 3) {
    for (const sf of sfs) {
      const line = lines.find(l => l.id === sf.lineId)!
      out.push({
        kind: 'CANT_DO',
        text: `${sf.market}: ${sf.missing} of ${line.trucks} truck${line.trucks === 1 ? '' : 's'} cannot be covered for ${fmt(line.startDate)}–${fmt(line.endDate)}.`
          + (sf.earliestPossibleStart ? ` The earliest another truck could be there is ${fmt(sf.earliestPossibleStart)}.` : ' No other truck is free for any part of that range.'),
      })
    }
  } else if (sfs.length > 3) {
    const names = sfs.map(x => x.market)
    out.push({
      kind: 'CANT_DO',
      text: `${short(plan)} truck${short(plan) === 1 ? '' : 's'} across ${sfs.length} markets cannot be covered on these dates: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` and ${names.length - 8} more` : ''}. `
        + `${plan.trucks.length} trucks are free for the whole run.`,
    })
  }

  // Fewer trucks: a wider weekly hop between markets.
  if (lines.some(l => l.daysPerWeek <= 3)) {
    for (const extra of [100, 200]) {
      const hop = ctx.s.hopLimitRoadMiles + extra
      if (hop > 450) break
      const p = ctx.run(lines, { ...ctx.s, hopLimitRoadMiles: hop })
      if (p.trucks.length < plan.trucks.length && short(p) <= short(plan)) {
        const sum = summarize(await ctx.price(lines, p), p)
        out.push({
          kind: 'FEWER_TRUCKS',
          text: `Letting a truck alternate between markets up to ${hop} road miles apart needs ${plan.trucks.length - p.trucks.length} fewer truck${plan.trucks.length - p.trucks.length === 1 ? '' : 's'} (${p.trucks.length} instead of ${plan.trucks.length}), with longer weekly drives.`
            + (cost(sum) !== cost(base) ? ` Transport ${cost(sum) < cost(base) ? 'falls' : 'rises'} by ${money(cost(sum) - cost(base))}.` : ''),
        })
        break
      }
    }
  }

  // A different hours model.
  const fiveByEight = lines.filter(l => l.daysPerWeek === 5 && l.hours <= 8)
  const threeByTwelve = lines.filter(l => l.daysPerWeek === 3 && l.hours === 12)
  const variant = fiveByEight.length
    ? { from: '5×8', to: '3×12', ids: new Set(fiveByEight.map(l => l.id)), dpw: 3, hours: 12 }
    : threeByTwelve.length
      ? { from: '3×12', to: '5×8', ids: new Set(threeByTwelve.map(l => l.id)), dpw: 5, hours: 8 }
      : null
  if (variant) {
    const alt = lines.map(l => (variant.ids.has(l.id) ? { ...l, daysPerWeek: variant.dpw, hours: variant.hours } : l))
    const p = ctx.run(alt)
    const altPriced = await ctx.price(alt, p)
    const sum = summarize(altPriced, p)
    const dTrucks = p.trucks.length - plan.trucks.length
    const dTotal = sum.grandTotal - base.grandTotal
    out.push({
      kind: 'HOURS_MODEL',
      text: `${variant.to} instead of ${variant.from} on ${variant.ids.size} market${variant.ids.size === 1 ? '' : 's'}: `
        + `${dTrucks === 0 ? 'the same number of trucks' : `${Math.abs(dTrucks)} ${dTrucks < 0 ? 'fewer' : 'more'} truck${Math.abs(dTrucks) === 1 ? '' : 's'}`}, `
        + `and the order total ${dTotal <= 0 ? 'falls' : 'rises'} by ${money(dTotal)} (${variant.to === '3×12' ? '36' : '40'} hours per market per week instead of ${variant.to === '3×12' ? '40' : '36'}).`,
    })
  }

  // A later start: the first that covers every market if some are short,
  // else the one that cuts transport most.
  const earliest = lines.reduce((m, l) => (l.startDate < m ? l.startDate : m), lines[0].startDate)
  const shifted = (days: number) => lines.map(l => ({ ...l, startDate: addDays(l.startDate, days), endDate: addDays(l.endDate, days) }))
  if (short(plan) > 0) {
    for (const days of START_SHIFTS) {
      const alt = shifted(days)
      const p = ctx.run(alt)
      if (short(p) > 0) continue
      const sum = summarize(await ctx.price(alt, p), p)
      out.push({
        kind: 'START_DATE',
        text: `Starting ${days} days later (${fmt(addDays(earliest, days))}) covers every market with ${p.trucks.length} trucks`
          + (sum.transportAbsorbed > 0 ? `, absorbing ${money(sum.transportAbsorbed)} of transport` : '')
          + (sum.transportBilled > 0 ? ` and billing ${money(sum.transportBilled)}` : '') + '.',
      })
      break
    }
  } else {
    let best: { days: number; saving: number; p: OrderPlan } | null = null
    for (const days of [7, 14, 21]) {
      const alt = shifted(days)
      const p = ctx.run(alt)
      if (short(p) > 0) continue
      const sum = summarize(await ctx.price(alt, p), p)
      const saving = cost(base) - cost(sum)
      if (saving >= 500 && (!best || saving > best.saving)) best = { days, saving, p }
    }
    if (best) {
      out.push({
        kind: 'START_DATE',
        text: `Starting ${best.days} days later (${fmt(addDays(earliest, best.days))}) cuts transport by ${money(best.saving)}`
          + (best.p.trucks.length !== plan.trucks.length ? ` and uses ${best.p.trucks.length} trucks instead of ${plan.trucks.length}.` : '.'),
      })
    }
  }
  return out
}

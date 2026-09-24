/**
 * The Claude layer of the multi-market planner.
 *
 * Claude does the three things code cannot do well, and nothing else:
 *
 *   1. extractFootprint — read a footprint that is not a clean CSV (a PDF, an
 *      email, a sheet laid out for people) into DMA / ZIP rows, plus whatever
 *      the client asked for (hours, days, start).
 *   2. reviewFootprint  — read the ZIP list the way a person would and spot
 *      what geometry cannot: a DMA label that names a different city than its
 *      ZIPs ("San Angelo" ZIPs that are San Antonio), a ZIP whose digits look
 *      transposed. Every suggested ZIP is then checked in code against the
 *      Census centroids before it is shown as verified.
 *   3. writePlanSummary — turn the plan's numbers into a write-up. Every number
 *      in the text is checked against the plan; any that is not in it is
 *      reported, never passed off as the plan's.
 *
 * All fleet maths stays in planner.ts. Claude is never asked to count trucks,
 * price anything or choose a truck.
 */

import Anthropic from '@anthropic-ai/sdk'
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema'
import { haversineDistance } from '@/lib/marketCoordinates'
import type { Area, AreaFlag, Centroids, ZipRow } from './areas'
import type { PlanResponse } from './run'
import { findLeaks } from './leaks'

export const PLANNER_MODEL = 'claude-opus-5'

let client: Anthropic | null = null
function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new ClaudeUnavailableError('ANTHROPIC_API_KEY is not set')
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return client
}

export class ClaudeUnavailableError extends Error {}

function assertUsable(msg: { stop_reason: string | null }, what: string): void {
  if (msg.stop_reason === 'refusal') throw new Error(`Claude declined to ${what}.`)
  if (msg.stop_reason === 'max_tokens') throw new Error(`The input was too long for Claude to ${what} in one pass. Split the file and try again.`)
}

// ---------------------------------------------------------------------------
// 1. Extraction
// ---------------------------------------------------------------------------

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows', 'request', 'notes'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['dma', 'zip', 'city', 'state'],
        properties: {
          dma: { type: 'string', description: 'DMA or market name as the client wrote it; empty string if none given' },
          zip: { type: 'string', description: 'Five-digit ZIP exactly as written, including any leading zeros' },
          city: { type: 'string' },
          state: { type: 'string', description: 'Two-letter state code, or empty string' },
        },
      },
    },
    request: {
      type: 'object',
      additionalProperties: false,
      required: ['client_name', 'hours_per_week', 'days_per_week', 'start_date', 'end_date', 'summary'],
      properties: {
        client_name: { type: 'string', description: 'Empty string if not stated' },
        hours_per_week: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        days_per_week: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        start_date: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'YYYY-MM-DD, or null if not stated' },
        end_date: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'YYYY-MM-DD, or null if not stated' },
        summary: { type: 'string', description: 'One sentence: what the client asked for, in their terms' },
      },
    },
    notes: { type: 'array', items: { type: 'string' }, description: 'Anything ambiguous about the file that a rep should confirm' },
  },
} as const

export type FootprintRequest = {
  clientName: string
  hoursPerWeek: number | null
  daysPerWeek: number | null
  startDate: string | null
  endDate: string | null
  summary: string
}

export type Extraction = { rows: ZipRow[]; request: FootprintRequest; notes: string[] }

const EXTRACT_SYSTEM = `You read client footprint files for Lime Media, which runs LED billboard trucks. A footprint lists the ZIP codes a client wants covered, usually grouped under DMA or market names.

Transcribe every ZIP row in the input. Copy ZIPs and names exactly as written, even when a value looks wrong: typos and odd labels are checked separately, and a silent correction would hide them. Keep leading zeros. If a row has no DMA, leave dma empty rather than guessing. Skip title rows, headers and totals.

Also record what the client asked for, if the input says: weekly hours, days per week, dates. Leave a field null when it is not stated. Do not infer it.`

export async function extractFootprint(input: { text?: string; pdfBase64?: string; fileName?: string }): Promise<Extraction> {
  const content: Anthropic.ContentBlockParam[] = []
  if (input.pdfBase64) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.pdfBase64 }, title: input.fileName })
  } else if (input.text) {
    content.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: input.text }, title: input.fileName })
  }
  content.push({ type: 'text', text: 'Extract the footprint from this file.' })

  const msg = await anthropic().messages
    .stream({
      model: PLANNER_MODEL,
      max_tokens: 64000,
      system: EXTRACT_SYSTEM,
      output_config: { effort: 'low', format: jsonSchemaOutputFormat(EXTRACT_SCHEMA) },
      messages: [{ role: 'user', content }],
    })
    .finalMessage()
  assertUsable(msg, 'read this file')
  const out = msg.parsed_output
  if (!out) throw new Error('Claude returned an unreadable result. Try again, or paste the ZIP list as CSV.')

  return {
    rows: out.rows
      .map(r => ({ label: r.dma.trim(), zip: r.zip.replace(/\D/g, '').padStart(5, '0').slice(0, 5), city: r.city.trim(), state: r.state.trim().toUpperCase() }))
      .filter(r => /^\d{5}$/.test(r.zip)),
    request: {
      clientName: out.request.client_name,
      hoursPerWeek: out.request.hours_per_week,
      daysPerWeek: out.request.days_per_week,
      startDate: out.request.start_date,
      endDate: out.request.end_date,
      summary: out.request.summary,
    },
    notes: out.notes,
  }
}

// ---------------------------------------------------------------------------
// 2. Review
// ---------------------------------------------------------------------------

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'zip', 'dma', 'detail', 'suggested_zip', 'suggested_dma'],
        properties: {
          kind: { type: 'string', enum: ['LABEL_MISMATCH', 'LIKELY_TYPO', 'OTHER'] },
          zip: { type: 'string', description: 'The ZIP concerned, or empty string if the finding is about a whole DMA' },
          dma: { type: 'string', description: 'The DMA label concerned, exactly as in the list' },
          detail: { type: 'string', description: 'One or two plain sentences a rep can read to the client' },
          suggested_zip: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'For a likely typo: the ZIP it was probably meant to be' },
          suggested_dma: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'For a label mismatch: the market the ZIPs are actually in' },
        },
      },
    },
  },
} as const

export type ReviewFinding = {
  kind: 'LABEL_MISMATCH' | 'LIKELY_TYPO' | 'OTHER'
  zip: string
  dma: string
  detail: string
  suggestedZip: string | null
  suggestedDma: string | null
  /** For a suggested ZIP: it exists and lies near the rest of its DMA. */
  verified: boolean
  verification: string
}

const REVIEW_SYSTEM = `You check client ZIP lists for Lime Media before a truck schedule is built from them. Code has already caught duplicates, PO-box ZIPs and ZIPs that geocode far from their DMA. You look for what geometry cannot see:

- LABEL_MISMATCH: a DMA label that names a different place than its ZIPs are in. For example, a label of "San Angelo" whose ZIPs are San Antonio ZIPs.
- LIKELY_TYPO: a ZIP that is probably a digit slip, such as a transposed or wrong first digit that moves it out of its state. Suggest the ZIP it was likely meant to be only when the city and state make it clear.
- OTHER: anything else a rep should confirm with the client, such as one DMA that spans places a single truck cannot cover in a day.

Each row carries lat and lng: where that ZIP actually is, from Census data (null when the ZIP has no residential area). Trust the coordinates over the city the client typed.

Report only real problems. An empty list is the right answer for a clean file. Do not repeat the problems code already flagged unless you can add a correction.`

export async function reviewFootprint(opts: {
  rows: ZipRow[]
  areas: Area[]
  flags: AreaFlag[]
  centroids: Centroids
}): Promise<ReviewFinding[]> {
  const byArea = opts.areas.map(a => ({ area: a.name, spread_miles: a.spreadMiles }))
  const payload = {
    // lat/lng come from the Census centroid, not from the client's text.
    rows: opts.rows.map(r => {
      const c = opts.centroids[r.zip]
      return { dma: r.label, zip: r.zip, city: r.city, state: r.state, lat: c ? c[0] : null, lng: c ? c[1] : null }
    }),
    areas: byArea,
    already_flagged: opts.flags.map(f => ({ kind: f.kind, zip: f.zip ?? '', detail: f.detail })),
  }

  const msg = await anthropic().messages
    .stream({
      model: PLANNER_MODEL,
      max_tokens: 16000,
      system: REVIEW_SYSTEM,
      output_config: { effort: 'medium', format: jsonSchemaOutputFormat(REVIEW_SCHEMA) },
      messages: [{ role: 'user', content: `Review this client ZIP list.\n\n${JSON.stringify(payload)}` }],
    })
    .finalMessage()
  assertUsable(msg, 'review this list')
  const out = msg.parsed_output
  if (!out) throw new Error('Claude returned an unreadable review.')

  return out.findings.map(f => verifyFinding(f, opts))
}

/** How close a suggested ZIP must be to the rest of its DMA to count as verified. */
export const VERIFY_MILES = 60

const norm = (x: string) => x.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Check a suggested ZIP in code before anyone acts on it.
 *
 * Verified means: the suggested ZIP exists AND lies within VERIFY_MILES of
 * the DMA's other ZIPs. With nothing to measure against — a one-ZIP DMA, or a
 * DMA name Claude spelled differently — it is never verified, because the
 * distance check is the whole safety property of the one-click Apply.
 */
export function verifyFinding(
  f: { kind: ReviewFinding['kind']; zip: string; dma: string; detail: string; suggested_zip: string | null; suggested_dma: string | null },
  ctx: { rows: ZipRow[]; centroids: Centroids },
): ReviewFinding {
  const base = { kind: f.kind, zip: f.zip, dma: f.dma, detail: f.detail, suggestedZip: f.suggested_zip, suggestedDma: f.suggested_dma }
  if (!f.suggested_zip) return { ...base, verified: false, verification: '' }

  const c = ctx.centroids[f.suggested_zip]
  if (!c) return { ...base, verified: false, verification: `${f.suggested_zip} is not a residential ZIP.` }

  // The DMA is the one the flagged ZIP is actually listed under; Claude's
  // spelling of the name is only a fallback.
  const listed = ctx.rows.find(r => r.zip === f.zip)
  const dma = listed ? listed.label : f.dma
  const siblings = ctx.rows
    .filter(r => norm(r.label) === norm(dma) && r.zip !== f.zip)
    .map(r => ctx.centroids[r.zip])
    .filter((p): p is [number, number] => Boolean(p))
  if (siblings.length === 0) {
    return { ...base, verified: false, verification: `${f.suggested_zip} exists, but ${dma || 'this DMA'} has no other ZIPs to check it against — confirm with the client.` }
  }
  const nearest = Math.min(...siblings.map(p => haversineDistance(p[0], p[1], c[0], c[1])))
  return nearest <= VERIFY_MILES
    ? { ...base, verified: true, verification: `${f.suggested_zip} exists and is ${Math.round(nearest)} mi from the rest of ${dma}.` }
    : { ...base, verified: false, verification: `${f.suggested_zip} exists but is ${Math.round(nearest)} mi from the rest of ${dma}.` }
}

// ---------------------------------------------------------------------------
// 3. Write-up
// ---------------------------------------------------------------------------

const WRITEUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['client_markdown', 'internal_markdown'],
  properties: {
    client_markdown: { type: 'string', description: 'The client-facing proposal, Markdown' },
    internal_markdown: { type: 'string', description: 'The internal summary for the sales lead, Markdown' },
  },
} as const

const WRITEUP_SYSTEM = `You write planning summaries for Lime Media's sales team. Lime Media runs LED billboard trucks. You are given a fleet plan that code has already computed. Your job is to explain it, not to change it.

Use only the numbers in the plan you are given. Do not compute new ones: no sums, differences, percentages or averages that are not already in the plan. If a number you want is not there, leave it out.

Write two separate texts.

client_markdown: a short proposal the rep can adapt. Say what we can offer: how many areas, how many hours each week, starting when (from the chosen plan), and at what weekly price. If the plan's model differs from what the client asked for, say so plainly and why, in one or two sentences. Mention any list corrections they need to confirm. Nothing internal, ever: no truck numbers, no transport or repositioning cost, no capacity or other clients, no AT&T or Alloy Build.

internal_markdown: for the sales lead. Cover the chosen start date and the transport we absorb for it, what an earlier or later date would cost (from the start-date options), what it leaves for other clients, the reservations assumed (AT&T, Alloy Build), the warnings, and the decisions still open. End with a table of the assigned trucks: route, truck number, start date. Short paragraphs and a few bullets.

Plain, specific sentences. No filler, no exclamation marks.`

export type WriteUp = {
  client: string
  internal: string
  /** Numbers in either text that are not in the plan. */
  unverifiedNumbers: string[]
  /** Terms that must never appear in the client text; the tab re-checks edits against these. */
  clientForbidden: string[]
  /** Forbidden terms actually found in the client text as drafted. */
  clientLeaks: string[]
}

export async function writePlanSummary(opts: {
  plan: PlanResponse
  areaCount: number
  zipCount: number
  flagsSummary: string[]
  clientRequest?: string
  /** The start-date row the rep chose. */
  selectedOption?: number
}): Promise<WriteUp> {
  const facts = planFacts(opts)
  const msg = await anthropic().messages
    .stream({
      model: PLANNER_MODEL,
      max_tokens: 16000,
      system: WRITEUP_SYSTEM,
      output_config: { effort: 'medium', format: jsonSchemaOutputFormat(WRITEUP_SCHEMA) },
      messages: [{ role: 'user', content: `Plan:\n\n${JSON.stringify(facts, null, 1)}` }],
    })
    .finalMessage()
  assertUsable(msg, 'write this summary')
  const out = msg.parsed_output
  if (!out) throw new Error('Claude returned an unreadable write-up.')

  const client = out.client_markdown.trim()
  const internal = out.internal_markdown.trim()
  const verifiable = verifiableFacts(facts)
  const forbidden = clientForbiddenTerms(opts.plan, opts.selectedOption)
  return {
    client,
    internal,
    unverifiedNumbers: [...new Set([...unverifiedNumbers(client, verifiable), ...unverifiedNumbers(internal, verifiable)])],
    clientForbidden: forbidden,
    clientLeaks: findLeaks(client, forbidden),
  }
}

/**
 * Terms that must never reach a client: every assigned truck number, the
 * transport we absorb, and the names of other commitments.
 */
export function clientForbiddenTerms(plan: PlanResponse, selectedOption?: number): string[] {
  const chosen = plan.dateOptions[selectedOption ?? plan.defaultOption] ?? plan.dateOptions[0]
  const trucks = (chosen?.liveBy.assignments ?? []).map(a => a.truckNumber).filter((t): t is string => !!t)
  const money = plan.dateOptions.flatMap(o => (o.liveBy.feasible && o.liveBy.repositionCost > 0 ? [o.liveBy.repositionCost.toLocaleString('en-US')] : []))
  return [...new Set([
    ...trucks,
    ...money.map(m => `$${m}`),
    'AT&T', 'ATT', 'Alloy', '160over90', 'soft hold',
    // A trailing * matches the stem: absorbed, repositioning, ...
    'absorb*', 'reposition*', 'deadhead*', 'capacity', 'other clients', 'maintenance',
  ])]
}


/** The plan reduced to what a write-up may cite — already rounded and labelled. */
export function planFacts(opts: { plan: PlanResponse; areaCount: number; zipCount: number; flagsSummary: string[]; clientRequest?: string; selectedOption?: number }) {
  const { plan } = opts
  const chosen = plan.dateOptions[opts.selectedOption ?? plan.defaultOption] ?? plan.dateOptions[0]
  const ms = chosen?.liveBy.milestones ?? []
  return {
    client_request: opts.clientRequest ?? null,
    areas: opts.areaCount,
    zips: opts.zipCount,
    list_corrections: opts.flagsSummary,
    model: plan.settings.model === '3x12' ? 'three 12-hour days per area per week' : 'five 8-hour days per area per week',
    trucks: plan.routes.length,
    paired_routes: plan.routes.filter(r => r.areaIds.length === 2).length,
    single_area_routes: plan.routes.filter(r => r.areaIds.length === 1).length,
    chosen_plan: chosen ? {
      everything_live_by: chosen.date,
      fully_live: chosen.liveBy.feasible,
      first_start: ms[0]?.date ?? null,
      routes_live_on_first_start: ms[0]?.routesLive ?? 0,
      milestones: ms,
      transport_absorbed: chosen.liveBy.repositionCost,
      moves_beyond_service_area: chosen.liveBy.movesOverServiceArea,
      // Internal only — the client section must not list trucks.
      assigned_trucks: chosen.liveBy.assignments.map(a => ({ route: a.routeName, truck: a.truckNumber, starts: a.start, coming_from: a.originLabel })),
    } : null,
    price_per_week: plan.pricing.chosen.totalPerWeek,
    price_per_quarter: plan.pricing.chosen.totalPerQuarter,
    rate_per_truck_day: plan.pricing.chosen.effectiveDailyRate,
    rate_per_truck_hour: plan.pricing.chosen.perTruckHour,
    hours_per_area_per_week: plan.settings.model === '3x12' ? 36 : 40,
    days_per_area_per_week: plan.settings.model === '3x12' ? 3 : 5,
    hours_per_day: plan.settings.model === '3x12' ? 12 : 8,
    days_per_week: 7,
    drivers_per_paired_route: 2,
    weeks_per_quarter: 13,
    alternative_model: {
      model: plan.pricing.other.model === '3x12' ? 'three 12-hour days' : 'five 8-hour days',
      trucks: plan.capacity.rows[1]?.programTrucks,
      price_per_week: plan.pricing.other.totalPerWeek,
    },
    start_date_options: plan.dateOptions.map(o => ({
      everything_live_by: o.date,
      possible: o.liveBy.feasible,
      transport_absorbed: o.liveBy.feasible ? o.liveBy.repositionCost : null,
      short_by_routes: o.liveBy.feasible ? 0 : o.liveBy.shortBy,
      routes_live_on_first_day: o.liveBy.milestones[0]?.routesLive ?? 0,
    })),
    capacity: {
      active_trucks: plan.capacity.activeTrucks,
      maintenance_reserve: plan.capacity.maintenanceReserve,
      att_trucks_low: plan.capacity.reservedLow,
      att_trucks_high: plan.capacity.reservedHigh,
      alloy_build_trucks_reserved: plan.capacity.renewingTrucks,
      left_for_other_clients: plan.capacity.rows.map(r => ({ model: r.model, low: r.leftLow, high: r.leftHigh })),
      history_last_52_weeks: plan.capacity.history,
    },
    reserved_trucks: plan.fleet.reserved.length,
    warnings: plan.warnings,
  }
}

/**
 * The facts a number may be verified against: the plan's own figures only.
 * The client's request and the list corrections are text that came from the
 * uploaded file (or Claude's reading of it), so a number planted in a file
 * could otherwise vouch for itself.
 */
export function verifiableFacts(facts: ReturnType<typeof planFacts>) {
  const plan: Partial<typeof facts> = { ...facts }
  delete plan.client_request
  delete plan.list_corrections
  return plan
}

/**
 * Numbers in the text that do not appear in the facts.
 *
 * Tolerant of formatting ($297,000 vs 297000, "36-hour"), but not of
 * arithmetic, and not of small numbers: truck, route and area counts are
 * exactly the figures that matter, so every number must come from the plan.
 * The plan carries the schedule constants a sentence needs (3 days, 12 hours,
 * 7-day week, 2 drivers) so that ordinary sentences still pass.
 */
export function unverifiedNumbers(text: string, facts: unknown): string[] {
  const known = new Set<string>()
  const walk = (v: unknown) => {
    if (typeof v === 'number') known.add(String(Math.round(v * 100) / 100))
    else if (typeof v === 'string') {
      for (const m of v.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) known.add(String(Number(m.replace(/,/g, ''))))
      const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
      if (d) { known.add(String(Number(d[2]))); known.add(String(Number(d[3]))); known.add(d[1]) }
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(facts)
  // Derived forms the prose legitimately uses.
  for (const k of [...known]) {
    const n = Number(k)
    if (n >= 1000) { known.add(String(Math.round(n / 1000))); known.add(String(Math.round(n / 100) / 10)) } // $297K, $3.9M-style
    if (n >= 1_000_000) known.add(String(Math.round(n / 100_000) / 10))
  }

  // Percentages are checked against percentages only: a "10" from a date
  // must not vouch for "10%".
  const percents = new Set((JSON.stringify(facts).match(/\d+(?:\.\d+)?%/g) ?? []))

  const out: string[] = []
  for (const m of text.matchAll(/\$?\d[\d,]*(?:\.\d+)?%?/g)) {
    const raw = m[0]
    const n = Number(raw.replace(/[$,%]/g, ''))
    if (!Number.isFinite(n)) continue
    if (raw.endsWith('%')) { if (!percents.has(raw)) out.push(raw); continue }
    if (known.has(String(Math.round(n * 100) / 100))) continue
    out.push(raw)
  }
  return [...new Set(out)]
}

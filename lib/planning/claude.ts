/**
 * The Claude layer of the multi-market quote.
 *
 * Claude does the two things code cannot do well, and nothing else:
 *
 *   1. extractFootprint — read a footprint that is not a clean CSV (a PDF, an
 *      email, a sheet laid out for people) into DMA / ZIP rows, plus whatever
 *      the client asked for (hours, days, start).
 *   2. reviewFootprint  — read the ZIP list the way a person would and spot
 *      what geometry cannot: a DMA label that names a different city than its
 *      ZIPs ("San Angelo" ZIPs that are San Antonio), a ZIP whose digits look
 *      transposed. Every suggested ZIP is then checked in code against the
 *      Census centroids before it is shown as verified.
 *
 * Routing and pricing stay in order.ts and quote.ts. Claude is never asked to
 * count trucks, price anything or choose a truck.
 */

import Anthropic from '@anthropic-ai/sdk'
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema'
import { haversineDistance } from '@/lib/marketCoordinates'
import type { Area, AreaFlag, Centroids, ZipRow } from './areas'

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


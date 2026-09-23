/**
 * POST /api/plan/areas — client footprint -> coverage areas.
 *
 * Internal staff only. Accepts any of:
 *   { text }                 pasted CSV / TSV, or an email body
 *   { file: { name, base64 } } an uploaded .csv, .txt, .xlsx or .pdf
 *   { rows }                 already-parsed rows, after a rep applied corrections
 *
 * Clean CSV and xlsx are parsed in code. A PDF, or text the parser cannot find
 * a ZIP column in, is read by Claude — which transcribes, never corrects, so
 * every problem still reaches the flags below. Then every ZIP is geocoded,
 * grouped into areas, and every correction is returned as a flag.
 */

import { NextRequest, NextResponse } from 'next/server'
import { buildAreas, parseZipRows, type AreaFlag, type Centroids, type ZipRow } from '@/lib/planning/areas'
import { xlsxToCsv } from '@/lib/planning/xlsx'
import { extractFootprint, type Extraction } from '@/lib/planning/claude'
import { requireStaff, claudeErrorResponse } from '@/lib/planning/http'
import centroidData from '@/lib/planning/data/zcta-centroids.json'

export const maxDuration = 300

const centroids = centroidData as unknown as Centroids
const MAX_TEXT = 2_000_000
const MAX_ROWS = 20_000

type Body = {
  text?: string
  file?: { name?: string; base64?: string }
  rows?: ZipRow[]
}

const isRow = (r: unknown): r is ZipRow => {
  const x = r as ZipRow
  return !!x && typeof x.zip === 'string' && /^\d{5}$/.test(x.zip)
    && typeof x.label === 'string' && typeof x.city === 'string' && typeof x.state === 'string'
}

export async function POST(req: NextRequest) {
  const denied = await requireStaff(req)
  if (denied) return denied

  let body: Body
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  let rows: ZipRow[] = []
  let parseFlags: AreaFlag[] = []
  let source: 'csv' | 'xlsx' | 'claude' | 'rows' = 'csv'
  let extraction: Extraction | null = null

  try {
    if (Array.isArray(body.rows)) {
      if (!body.rows.every(isRow) || body.rows.length > MAX_ROWS) return NextResponse.json({ error: 'Invalid rows.' }, { status: 400 })
      rows = body.rows
      source = 'rows'
    } else {
      const name = (body.file?.name ?? '').toLowerCase()
      let text = typeof body.text === 'string' ? body.text : ''
      let pdf: string | null = null

      if (body.file?.base64) {
        const buf = Buffer.from(body.file.base64, 'base64')
        if (name.endsWith('.xlsx')) { text = xlsxToCsv(buf); source = 'xlsx' }
        else if (name.endsWith('.pdf')) pdf = body.file.base64
        else if (name.endsWith('.xls')) return NextResponse.json({ error: 'Old .xls files are not supported. Save as .xlsx or CSV and upload again.' }, { status: 400 })
        else text = buf.toString('utf8')
      }
      if (text.length > MAX_TEXT) return NextResponse.json({ error: 'That file is too large.' }, { status: 413 })

      if (!pdf) {
        const parsed = parseZipRows(text)
        rows = parsed.rows
        parseFlags = parsed.flags
      }
      // Nothing a parser could use — a PDF, an email, a sheet laid out for people.
      if (pdf || rows.length === 0) {
        if (!pdf && !text.trim()) return NextResponse.json({ error: 'Paste or upload the client ZIP list first.' }, { status: 400 })
        extraction = await extractFootprint({ text: pdf ? undefined : text, pdfBase64: pdf ?? undefined, fileName: body.file?.name })
        rows = extraction.rows
        parseFlags = []
        source = 'claude'
      }
    }
  } catch (err) {
    return claudeErrorResponse(err, 'areas')
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: 'No ZIP codes found in that input.' }, { status: 400 })
  }

  const result = buildAreas(rows, centroids)
  return NextResponse.json({
    ...result,
    flags: [...parseFlags, ...result.flags],
    source,
    parsedRows: rows,
    request: extraction?.request ?? null,
    notes: extraction?.notes ?? [],
  })
}

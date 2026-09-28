/**
 * Minimal .xlsx reader: every sheet's cell values, as CSV text.
 *
 * Client footprints arrive as spreadsheets. A full spreadsheet library is a
 * large dependency for "read the values out", and the npm build of the usual
 * one carries unpatched advisories, so this reads the format directly: an xlsx
 * is a zip of XML parts, and only three matter here — the workbook (sheet
 * order), the shared-strings table, and each sheet's cells.
 *
 * Values only. Formulas are read from their cached result, which is what a
 * client export contains. Server-side (Node zlib).
 */

import { inflateRawSync } from 'zlib'

type ZipEntry = { name: string; data: Buffer }

/** Cap on any one decompressed part, so a malformed or hostile file cannot exhaust memory. */
const MAX_PART_BYTES = 50 * 1024 * 1024

/** Read a zip's central directory and inflate every entry. */
function readZip(buf: Buffer): Map<string, Buffer> {
  // End of central directory record: scan back from the end for its signature.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no zip directory found)')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)

  const entries: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt .xlsx zip directory')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen

    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(start, start + compSize)
    if (method === 0) entries.push({ name, data: Buffer.from(raw) })
    else if (method === 8) entries.push({ name, data: inflateRawSync(raw, { maxOutputLength: MAX_PART_BYTES }) })
    // Other methods do not occur in xlsx; skip rather than fail.
  }
  return new Map(entries.map(e => [e.name, e.data]))
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

/** All <t> text inside an element, concatenated (rich text splits a string into runs). */
function textOf(xml: string): string {
  let out = ''
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out += decodeXml(m[1])
  return out
}

/** Excel's last column is XFD, index 16,383. Nothing real lies beyond it. */
export const MAX_COLUMN_INDEX = 16_383

/**
 * Zero-based column index of a cell reference, or -1 past Excel's last column.
 * A crafted reference like "ZZZZZZZZ1" would otherwise decode to billions, and
 * the row would be padded out to that length.
 */
export function columnIndex(ref: string): number {
  const letters = ref.replace(/\d+$/, '')
  if (letters.length > 3) return -1
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1 <= MAX_COLUMN_INDEX ? n - 1 : -1
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export type XlsxSheet = { name: string; rows: string[][] }

export function readXlsx(buf: Buffer): XlsxSheet[] {
  const files = readZip(buf)
  const get = (name: string) => files.get(name)?.toString('utf8')

  const shared: string[] = []
  const sst = get('xl/sharedStrings.xml')
  if (sst) {
    const re = /<si>([\s\S]*?)<\/si>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(sst))) shared.push(textOf(m[1]))
  }

  // Sheet order and names from the workbook, targets from its relationships.
  const workbook = get('xl/workbook.xml') ?? ''
  const rels = get('xl/_rels/workbook.xml.rels') ?? ''
  const target = new Map<string, string>()
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1]
    const t = /Target="([^"]+)"/.exec(m[0])?.[1]
    if (id && t) target.set(id, t.replace(/^\/?xl\//, '').replace(/^\//, ''))
  }
  const sheets: XlsxSheet[] = []
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXml(/name="([^"]*)"/.exec(m[0])?.[1] ?? '')
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1]
    const path = rid ? target.get(rid) : undefined
    const xml = path ? get(`xl/${path}`) : undefined
    if (!xml) continue

    const rows: string[][] = []
    for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row: string[] = []
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1]
        const body = cm[2] ?? ''
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1]
        const type = /t="([^"]+)"/.exec(attrs)?.[1]
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
        let value = ''
        if (type === 's' && v !== undefined) value = shared[Number(v)] ?? ''
        else if (type === 'inlineStr') value = textOf(body)
        else if (v !== undefined) value = decodeXml(v)
        const idx = ref ? columnIndex(ref) : row.length
        if (idx < 0 || idx > MAX_COLUMN_INDEX) continue
        while (row.length < idx) row.push('')
        row[idx] = value.trim()
      }
      if (row.some(c => c !== '')) rows.push(row)
    }
    sheets.push({ name, rows })
  }
  return sheets
}

/** Every sheet as CSV, one after another. Repeated header rows are expected downstream. */
export function xlsxToCsv(buf: Buffer): string {
  return readXlsx(buf)
    .map(s => s.rows.map(r => r.map(csvCell).join(',')).join('\n'))
    .join('\n')
}

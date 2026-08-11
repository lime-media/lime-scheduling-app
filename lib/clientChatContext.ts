import { query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { SCHEDULED_QUERY, CHAT_CONTEXT_QUERY } from '@/lib/scheduleQuery'
import type { ClientSession } from '@/lib/clientAuth'

const HIDDEN_TRUCKS = new Set(['0001', '0002', '1257', '00001257', '1991'])

function toDateStr(val: unknown): string {
  if (!val) return ''
  if (val instanceof Date) return val.toISOString().split('T')[0]
  const s = String(val)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  try { return new Date(s).toISOString().split('T')[0] } catch { return '' }
}

function normalizeMarket(m: unknown): string {
  return String(m ?? '').replace(/\s*,\s*/g, ', ').trim()
}

function nextDayStr(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().split('T')[0]
}

type Block = { start: string; end: string; market: string; state: string }

/**
 * Builds the AI context for ONE client's chat session.
 *
 * SAFETY — this is the only place the client chat route pulls facts from, and it is designed
 * so no OTHER client's identity can ever reach the model, let alone the client on the other
 * end of the conversation:
 *
 *  - Other clients' truck bookings are reduced to "booked" + destination market/state + dates.
 *    No client_name, no notes, no hold status label is included — the internal `Hold.status`
 *    value ("ATT_SOFT") is deliberately withheld too, not just the free-text name, since the
 *    status itself names a client (AT&T). This is the same level of detail the client Schedule
 *    Grid already shows visually (a booked cell with a destination, no attribution) — nothing
 *    new is exposed here, it's just phrased for the model instead of a grid cell.
 *  - The requesting client's OWN hold requests are included in full — that's their own data.
 *
 * If this function is ever extended, run every new field through: "could this name, or let
 * someone infer, another client?" before adding it.
 */
export async function buildClientChatContext(session: ClientSession): Promise<string> {
  const today = new Date().toISOString().split('T')[0]

  const [scheduleRows, contextRows, holds, myRequests] = await Promise.all([
    query<Record<string, unknown>[]>(SCHEDULED_QUERY),
    query<Record<string, unknown>[]>(CHAT_CONTEXT_QUERY),
    prisma.hold.findMany({ orderBy: { start_date: 'asc' } }),
    prisma.holdRequest.findMany({ where: { client_user_id: session.id }, orderBy: { created_at: 'desc' } }),
  ])

  // Merge consecutive same-market schedule days into ranges (same approach as the internal
  // assistant's context builder) — no client attribution exists in this query to begin with.
  const byTruck = new Map<string, Block[]>()
  for (const row of scheduleRows) {
    const truckNumber = String(row.truck_number ?? '')
    if (HIDDEN_TRUCKS.has(truckNumber)) continue
    const day    = toDateStr(row.shift_start)
    const market = normalizeMarket(row.standard_market_name) || normalizeMarket(row.market)
    const state  = String(row.state ?? '')
    const blocks = byTruck.get(truckNumber) ?? []
    const last   = blocks[blocks.length - 1]
    if (last && day === nextDayStr(last.end) && market === last.market && state === last.state) {
      last.end = day
    } else {
      blocks.push({ start: day, end: day, market, state })
    }
    byTruck.set(truckNumber, blocks)
  }

  // Fold holds (any client's) into the same per-truck "unavailable" picture. Status and name
  // are deliberately never read from `h` here — see the safety note above.
  for (const h of holds) {
    if (HIDDEN_TRUCKS.has(h.truck_number)) continue
    const blocks = byTruck.get(h.truck_number) ?? []
    blocks.push({ start: toDateStr(h.start_date), end: toDateStr(h.end_date), market: h.market, state: h.state ?? '' })
    byTruck.set(h.truck_number, blocks)
  }

  const truckLines = Array.from(byTruck.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([truckNumber, blocks]) => {
      const ranges = blocks
        .sort((a, b) => a.start.localeCompare(b.start))
        .map((b) => {
          const range = b.start === b.end ? b.start : `${b.start} → ${b.end}`
          const where = [b.market, b.state].filter(Boolean).join(', ')
          return `booked ${range}${where ? ` (${where})` : ''}`
        })
        .join('; ')
      return `- Truck ${truckNumber}: ${ranges || 'no bookings on file'}`
    })

  // Trucks with no row in scheduleRows/holds above are fully open right now — but that also
  // means byTruck has nothing to say about WHERE they are. Without this, the model has zero
  // location data for exactly the trucks a client is most likely to ask about (open trucks),
  // and would have to say so outright rather than answer. Same fallback the internal admin
  // chat and the Schedule Grid itself use for idle trucks: last-known market from the LED
  // schedule (CHAT_CONTEXT_QUERY's last_known_market). No client attribution involved — this
  // is the truck's own most recent program's market, not another client's identity — so it
  // doesn't touch the isolation guarantee described above.
  const lastKnownLines = contextRows
    .filter((row) => {
      const truckNumber = String(row.truck_number ?? '')
      return !HIDDEN_TRUCKS.has(truckNumber) && !byTruck.has(truckNumber) && normalizeMarket(row.last_known_market)
    })
    .sort((a, b) => String(a.truck_number).localeCompare(String(b.truck_number)))
    .map((row) => `- Truck ${row.truck_number}: no bookings on file; last known market ${normalizeMarket(row.last_known_market)}`)

  const myRequestLines = myRequests.map((r) => {
    const start = toDateStr(r.start_date)
    const end   = toDateStr(r.end_date)
    const where = [r.market, r.state].filter(Boolean).join(', ')
    return `- Truck ${r.truck_number}: ${r.status} in ${where} (${start} → ${end})${r.notes ? ' — notes: ' + r.notes : ''}`
  })

  // The actual known-through date for the LED program schedule — NOT a fixed constant. The
  // nominal query window is -30/+63 days, but real schedule data often thins out well before
  // that (e.g. programs simply haven't been entered that far ahead yet). Computing this from
  // the rows actually returned, rather than assuming the full nominal window is populated, is
  // what caught a real bug: the assistant was confidently listing trucks as "available" on a
  // date ~2 weeks past where the real data ends, purely because nothing existed to contradict
  // it. Holds (unlike the LED schedule) have no date bound in the query, so a hold can reliably
  // inform us about a date beyond this horizon whenever one exists — only the ABSENCE of a
  // schedule/hold entry stops being meaningful once you're past it.
  const scheduleHorizon = scheduleRows.reduce((max, row) => {
    const d = toDateStr(row.shift_start)
    return d && d > max ? d : max
  }, today)

  return `Today's date: ${today}.

VISIBILITY LIMIT — read before answering any availability question: the LED program schedule in this data is only populated through ${scheduleHorizon}. For any date ON OR BEFORE ${scheduleHorizon}, an absence of a listed booking below means the truck is genuinely available. For any date AFTER ${scheduleHorizon}, an absence of a listed booking means NOTHING — there is no data either way that far out, so you cannot confirm availability. (Holds are the exception: a hold below is reliable evidence regardless of date, even past ${scheduleHorizon}, whenever one is actually listed for that truck.)

TRUCK AVAILABILITY (see the visibility limit above before treating "not listed" as "available"):
${[...truckLines, ...lastKnownLines].join('\n') || 'No bookings on file.'}

${session.companyName.toUpperCase()}'S OWN HOLD REQUESTS (${myRequests.length} total) — the only client whose hold-request details you may ever discuss:
${myRequestLines.join('\n') || 'No hold requests on file.'}`
}

import { query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { SCHEDULED_QUERY, CHAT_CONTEXT_QUERY } from '@/lib/scheduleQuery'
import { getLiveVehicleLocations } from '@/lib/samsaraService'
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
// Truck numbers are zero-padded strings in the DB ("0044", "0751") — but when the model copies
// one into a compact `truck: <truck_number>` action-block field, it sometimes "cleans up" the
// leading zeros (writing "44" instead of "0044"), since a bare few-digit code reads like a
// number rather than a fixed-width string. An exact-string match against that would reject a
// perfectly valid truck and silently fail the whole hold submission — this was a real incident
// (see buildClientChatContext below). Normalizing away leading zeros on both sides of the
// lookup makes the match immune to that formatting drift.
export function normalizeTruckNumber(truckNumber: string): string {
  return truckNumber.trim().replace(/^0+(?=\d)/, '')
}

export interface ClientChatContext {
  prompt: string
  // Truck numbers with ANY known location signal (live GPS or schedule-derived market) — used
  // as a hard backstop before actually submitting a hold request. Independent of market
  // matching (near, far, or out-of-state are all fine per the cross-market fulfillment rule) —
  // this only blocks the narrower case of a truck we have literally zero location data for.
  // Real incident this caught: the model picked such a truck as an out-of-market "filler" and
  // submitted a hold for it with no idea where it actually is.
  //
  // Keyed by BOTH the raw truck number and its zero-stripped form (see normalizeTruckNumber),
  // each mapping to the canonical (DB-format) truck number — so a lookup succeeds and resolves
  // to the right string to persist, regardless of which form the model wrote in its reply.
  knownLocationTrucks: Map<string, string>
}

export async function buildClientChatContext(session: ClientSession): Promise<ClientChatContext> {
  const today = new Date().toISOString().split('T')[0]

  const [scheduleRows, contextRows, holds, gpsMap] = await Promise.all([
    query<Record<string, unknown>[]>(SCHEDULED_QUERY),
    query<Record<string, unknown>[]>(CHAT_CONTEXT_QUERY),
    prisma.hold.findMany({ where: { status: { not: 'EXPIRED' } }, orderBy: { start_date: 'asc' } }),
    getLiveVehicleLocations().catch(() => new Map<string, { formatted_address: string; city: string; state: string }>()),
  ])

  // This client's own holds — returned separately with full detail
  const myRequests = holds.filter(h => h.client_user_id === session.id)

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

  // Last-known market per truck. Live GPS wins when available — it's the only signal that can
  // never go stale — with the CHAT_CONTEXT_QUERY schedule-derived market as a fallback for
  // trucks Samsara has no current fix on. Same priority the internal staff assistant already
  // uses (app/api/chat/route.ts: "live Samsara GPS first, then last_known_market from DB").
  // Getting this backwards is a real bug we hit: a truck's most recent LED program can be from
  // weeks ago in one market while the truck has since been relocated across the country — the
  // schedule-derived value doesn't know that, but live GPS always reflects where it is right now.
  const lastKnownMarketByTruck = new Map<string, string>()
  for (const row of contextRows) {
    const truckNumber = String(row.truck_number ?? '')
    if (HIDDEN_TRUCKS.has(truckNumber)) continue
    const gpsData = gpsMap.get(truckNumber)
    if (gpsData?.city) {
      lastKnownMarketByTruck.set(truckNumber, [gpsData.city, gpsData.state].filter(Boolean).join(', '))
    } else {
      const market = normalizeMarket(row.last_known_market)
      if (market) lastKnownMarketByTruck.set(truckNumber, market)
    }
  }

  const allTruckNumbers = new Set<string>(byTruck.keys())
  for (const row of contextRows) {
    const truckNumber = String(row.truck_number ?? '')
    if (!HIDDEN_TRUCKS.has(truckNumber)) allTruckNumbers.add(truckNumber)
  }

  const truckLines = Array.from(allTruckNumbers)
    .sort((a, b) => a.localeCompare(b))
    .map((truckNumber) => {
      const blocks = byTruck.get(truckNumber) ?? []
      const ranges = blocks
        .sort((a, b) => a.start.localeCompare(b.start))
        .map((b) => {
          const range = b.start === b.end ? b.start : `${b.start} → ${b.end}`
          const where = [b.market, b.state].filter(Boolean).join(', ')
          return `booked ${range}${where ? ` (${where})` : ''}`
        })
        .join('; ')
      const lastKnown = lastKnownMarketByTruck.get(truckNumber)
      const lastKnownPart = lastKnown ? ` | last known market: ${lastKnown}` : ''
      return `- Truck ${truckNumber}: ${ranges || 'no bookings on file'}${lastKnownPart}`
    })

  const myRequestLines = myRequests.map((r) => {
    const start = toDateStr(r.start_date)
    const end   = toDateStr(r.end_date)
    const where = [r.market, r.state].filter(Boolean).join(', ')
    return `- Truck ${r.truck_number}: ${r.status} in ${where} (${start} → ${end})${r.notes ? ' — notes: ' + r.notes : ''}`
  })

  const prompt = `Today's date: ${today}.

AVAILABILITY RULE: a truck is available for a requested date whenever no booked range listed below covers that date — this holds for near-term dates and far-future dates alike. An unbuilt/not-yet-entered LED schedule for a future date means the truck is genuinely open then, not unknown, so never refuse to confirm availability just because a date is far out. Each truck's "last known market" is its live current GPS location when available (otherwise its most recent program's market) — use it as your best signal for WHERE an available truck actually is right now, especially once its listed booked ranges run out. Never assume a truck is near a requested city just because it was scheduled there in the past — check this field.

TRUCK AVAILABILITY:
${truckLines.join('\n') || 'No bookings on file.'}

${session.companyName.toUpperCase()}'S OWN HOLD REQUESTS (${myRequests.length} total) — the only client whose hold-request details you may ever discuss:
${myRequestLines.join('\n') || 'No hold requests on file.'}`

  const knownLocationTrucks = new Map<string, string>()
  for (const truckNumber of lastKnownMarketByTruck.keys()) {
    knownLocationTrucks.set(truckNumber, truckNumber)
    knownLocationTrucks.set(normalizeTruckNumber(truckNumber), truckNumber)
  }

  return { prompt, knownLocationTrucks }
}

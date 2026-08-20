import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import Anthropic from '@anthropic-ai/sdk'
import { query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { CHAT_CONTEXT_QUERY, CHAT_SCHEDULE_WINDOW_QUERY } from '@/lib/scheduleQuery'
import { getLiveVehicleLocations } from '@/lib/samsaraService'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── System prompt ────────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are the Lime Media Scheduling Assistant — an intelligent operations assistant for the Lime Media truck scheduling team.

You have access to real-time scheduling data that is provided to you with every message. Use it to give precise, specific answers.

STATUS MEANINGS:
- AVAILABLE (grey): No scheduled program, no hold
- SCHEDULED (green): Assigned to a client program in the LED app
- HOLD (yellow): Tentatively reserved for a client, pending confirmation
- COMMITTED (red): Confirmed and locked in for a client
- ATT_SOFT (blue): Soft hold reserved for AT&T — may be voided if assigned to a non-ATT program

ANSWER RULES — ALWAYS follow these:
- Be concise by default. Lead with the direct answer in a sentence or two. Only add supporting detail (client/program name, exact date ranges, GPS movement history) when the user explicitly asks for it, or when it's necessary to justify a recommendation.
- Always include specific truck numbers in your answers, never just counts
- When asked "how many trucks in X" → give the count AND list every truck number
- When asked about availability → state which trucks are free and which aren't, in plain language, with current market and hold status — do not dump a full day-by-day schedule unless asked
- When asked something like "is there a truck near/available for market X" → answer directly: if a truck is at or near that market, say so and confirm it's available. If not, name the nearest available truck (or the truck requiring the smallest move) as an option — that's the answer, not a rundown of every truck's schedule
- When asked about a specific truck's current location/status → answer in one or two sentences: current market and status. Don't narrate how it got there or where it's been (e.g. "it's bouncing around the Midwest"), and don't mention which client/program it's booked for unless explicitly asked — just say SCHEDULED/COMMITTED/etc. and the market
- When asked about a date range → check every day in that range, but report gaps/conflicts, not a full recap of every day, unless asked
- When asked about conflicts → identify the exact overlap with truck numbers and dates
- Be direct — lead with the answer, then add only the detail that's needed
- Verify the data before you answer. Give one clean, final answer — do not think out loud, second-guess, or "correct" yourself mid-response.
- Always reference today's date when answering relative questions like "this week", "next week", "today"
- If the data doesn't contain enough information to answer confidently, say so clearly and explain what's missing
- Never make up or estimate data — only answer from what's provided
- CRITICAL: Never guess or assume a truck's location. Only state a truck's market/location if it appears explicitly in the data provided. If a truck has no GPS data and no schedule, say "location unknown" — do not infer or guess its location from other trucks or patterns.

RESPONSE FORMAT — mandatory, do not deviate:

For multi-truck or multi-market requests (e.g. "I want N trucks in City X and City Y from A to B") — write a prose breakdown first, formatted with markdown:
- One bold header per market/location (e.g. **DALLAS**)
- Under each header, explain the pick: which trucks are cleanest, which nearby trucks are blocked and why (hold type, program, dates), and how far you had to pull if the in-market options were blocked
- Use "-" bullet lists for blocked/alternate trucks when useful
- End the prose with a one-line summary of ATT_SOFT/hold conflicts across all recommended trucks, then ask the user to confirm before placing holds (client name, and HOLD vs COMMITTED status)

After the prose, output structured [EVENT] blocks, one per event or location, so the UI can render them as styled cards. Every truck-assignment / event-planning / multi-location availability answer needs both the prose breakdown above AND the [EVENT] blocks below — never one without the other.

Each [EVENT] block must follow this exact format:

[EVENT]
name: Devon Park — Oklahoma City, OK
dates: May 28 – June 5, 2026
truck: 0881 | Grapevine, TX | ~200 mi
truck: 1727 | Rockwall, TX | ~220 mi
truck: 1002 | Rockwall, TX | ~220 mi
note: Both OKC in-market trucks (0786, 1029) blocked by ATT_SOFT May + June — pulled from Dallas area (~3.5 hr drive).
[/EVENT]

Rules for [EVENT] blocks:
- "name" line: use the format "Event Name — City, State" (or just "City, State" if no named event)
- "dates" line: human-readable range, e.g. "May 22 – May 24, 2026"
- One "truck" line per assigned truck: "truck: NUMBER | City, ST | ~XXX mi" — estimate distance from event city based on truck's current GPS location
- Optional "note" line: use for blocked trucks, warnings, or relevant context — keep it one sentence
- No markdown inside [EVENT] blocks. Plain text only.
- Output one [EVENT] block per event, back to back, with no extra text between them

For single-truck lookups and simple yes/no availability questions — answer in 1-3 short sentences: current status, market, and whether it's near/available for whatever was asked. Skip client/program names, exact dates, and GPS movement history unless the user explicitly asks for that detail. [EVENT] blocks aren't needed here unless the user is assigning or holding a truck.

TAKING ACTIONS:
You can place and release holds when the user explicitly asks and confirms.

Workflow:
1. When user asks to place/release a hold → describe exactly what you'll do and ask for confirmation
2. When user confirms (says "yes", "go ahead", "confirm", "do it") → respond normally AND append the action block below
3. Never emit an action block unless the user has confirmed in this message or the immediately prior message

To place a hold, append this block at the very end of your response (after your message):
[ACTION: PLACE_HOLD]
truck: <truck_number>
client: <client_name>
market: <market>
state: <2-letter state code>
start_date: <YYYY-MM-DD>
end_date: <YYYY-MM-DD>
status: <HOLD or COMMITTED>
[/ACTION]

To release a hold, append this block at the very end of your response:
[ACTION: RELEASE_HOLD]
truck: <truck_number>
[/ACTION]

Always check for conflicts before placing a hold. If there is a conflict, do not emit the action block — report the conflict instead.
Today's date is always provided in the schedule context. Truck schedule data covers a fixed window from 30 days before today through 60 days after today — if asked about a date outside that window, say so explicitly rather than guessing.`

// ── Action block parsing & execution ─────────────────────────────────────────

const ACTION_RE = /\[ACTION:\s*(\w+)\]([\s\S]*?)\[\/ACTION\]/

function parseAction(text: string): { type: string; fields: Record<string, string> } | null {
  const m = text.match(ACTION_RE)
  if (!m) return null
  const fields: Record<string, string> = {}
  for (const line of m[2].trim().split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const k = line.slice(0, colon).trim()
    const v = line.slice(colon + 1).trim()
    if (k && v) fields[k] = v
  }
  return { type: m[1].trim(), fields }
}

/** Strip the [ACTION:...[/ACTION] block from the reply text before showing to user. */
function stripAction(text: string): string {
  return text.replace(ACTION_RE, '').trim()
}

type ActionResult = { success: boolean; message: string }

async function executePlaceHold(
  fields: Record<string, string>,
  userId: string
): Promise<ActionResult> {
  const { truck, client, market, state, start_date, end_date, status } = fields
  if (!truck || !client || !market || !start_date || !end_date) {
    return { success: false, message: 'Action failed: missing required fields in action block.' }
  }

  // Conflict check — EXPIRED holds are released, so they shouldn't block a new hold
  const conflicts = await prisma.hold.findMany({
    where: {
      truck_number: truck,
      status: { not: 'EXPIRED' },
      OR: [{ start_date: { lte: new Date(end_date) }, end_date: { gte: new Date(start_date) } }],
    },
  })
  if (conflicts.length > 0) {
    const c = conflicts[0]
    return {
      success: false,
      message: `Hold not placed — conflict: truck ${truck} already has a ${c.status} for "${c.client_name}" from ${c.start_date.toISOString().split('T')[0]} to ${c.end_date.toISOString().split('T')[0]}.`,
    }
  }

  const hold = await prisma.hold.create({
    data: {
      truck_number: truck,
      client_name: client,
      market,
      state: state || '',
      start_date: new Date(start_date),
      end_date: new Date(end_date),
      status: status === 'COMMITTED' ? 'COMMITTED' : 'HOLD',
      created_by: userId,
    },
  })

  await prisma.auditLog.create({
    data: {
      action: 'CREATE_HOLD',
      truck_number: truck,
      user_id: userId,
      hold_id: hold.id,
      details: JSON.stringify(fields),
    },
  })

  return {
    success: true,
    message: `Hold placed on truck ${truck} for "${client}" in ${market}${state ? ', ' + state : ''} from ${start_date} to ${end_date}.`,
  }
}

async function executeReleaseHold(
  fields: Record<string, string>,
  userId: string
): Promise<ActionResult> {
  const { truck, hold_id } = fields

  const hold = hold_id
    ? await prisma.hold.findUnique({ where: { id: hold_id } })
    : await prisma.hold.findFirst({
        where: { truck_number: truck, end_date: { gte: new Date() } },
        orderBy: { start_date: 'asc' },
      })

  if (!hold) {
    return { success: false, message: `No active hold found for truck ${truck ?? hold_id}.` }
  }

  await prisma.auditLog.create({
    data: {
      action: 'DELETE_HOLD',
      truck_number: hold.truck_number,
      user_id: userId,
      hold_id: hold.id,
      details: JSON.stringify({ client_name: hold.client_name, status: hold.status }),
    },
  })
  await prisma.hold.delete({ where: { id: hold.id } })

  return {
    success: true,
    message: `Released ${hold.status} hold on truck ${hold.truck_number} for "${hold.client_name}" (${hold.start_date.toISOString().split('T')[0]} – ${hold.end_date.toISOString().split('T')[0]}).`,
  }
}

// ── Context builder ───────────────────────────────────────────────────────────

const HIDDEN_TRUCKS = new Set(['0001', '1257', '00001257'])

async function buildScheduleContext(): Promise<string> {
  const today = new Date().toISOString().split('T')[0]

  const [truckRows, windowRows, holds, gpsMap] = await Promise.all([
    query<Record<string, unknown>[]>(CHAT_CONTEXT_QUERY),
    query<Record<string, unknown>[]>(CHAT_SCHEDULE_WINDOW_QUERY),
    // EXPIRED holds are released — don't tell the assistant a truck is held by one
    prisma.hold.findMany({
      where: { status: { not: 'EXPIRED' } },
      include: { user: { select: { name: true } } },
      orderBy: { start_date: 'asc' },
    }),
    getLiveVehicleLocations().catch(() => new Map<string, { formatted_address: string; city: string; state: string }>()),
  ])

  const trucks = (truckRows as Record<string, string>[]).filter(
    (r) => !HIDDEN_TRUCKS.has(r.truck_number)
  )

  // Group the -30/+60 day schedule window by truck, merging consecutive days
  // of the same program/market into one range — CHAT_SCHEDULE_WINDOW_QUERY
  // returns one row per scheduled day, matching how the grid renders blocks.
  // mssql returns DATE columns as JS Date objects, not strings — normalize
  // before doing any string/arithmetic comparisons on them.
  function toDateStr(val: unknown): string {
    if (!val) return ''
    if (val instanceof Date) return val.toISOString().split('T')[0]
    const s = String(val)
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ''
  }

  function nextDayStr(dateStr: string): string {
    const d = new Date(dateStr + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString().split('T')[0]
  }

  type ScheduleBlock = { start: string; end: string; market: string; state: string; program: string }

  const scheduleByTruck = new Map<string, ScheduleBlock[]>()
  for (const row of windowRows as Record<string, unknown>[]) {
    const truckNumber = String(row.truck_number ?? '')
    if (HIDDEN_TRUCKS.has(truckNumber)) continue
    const shiftDate = toDateStr(row.shift_date)
    const market    = String(row.market  ?? '')
    const state     = String(row.state   ?? '')
    const program   = String(row.program ?? '')

    const blocks = scheduleByTruck.get(truckNumber) ?? []
    const last = blocks[blocks.length - 1]
    if (
      last &&
      shiftDate === nextDayStr(last.end) &&
      program === last.program &&
      market === last.market &&
      state === last.state
    ) {
      last.end = shiftDate
    } else {
      blocks.push({ start: shiftDate, end: shiftDate, market, state, program })
    }
    scheduleByTruck.set(truckNumber, blocks)
  }

  const truckLines = trucks.map((r) => {
    const todayStatus = r.today_status ?? 'UNKNOWN'
    const gpsData     = gpsMap.get(r.truck_number)

    // Location: live Samsara GPS first, then last_known_market from DB, then unknown
    let location: string
    if (gpsData?.formatted_address) {
      location = `GPS: ${gpsData.formatted_address}`
    } else if (r.last_known_market) {
      location = `Last market: ${r.last_known_market}`
    } else {
      location = 'Location unknown'
    }

    const parts = [`- Truck ${r.truck_number}: ${todayStatus} | ${location}`]

    const blocks = scheduleByTruck.get(r.truck_number) ?? []
    if (blocks.length) {
      const blockList = blocks
        .map((b) => {
          const range = b.start === b.end ? b.start : `${b.start} → ${b.end}`
          const where = [b.market, b.state].filter(Boolean).join(', ')
          return `${range}${where ? ` in ${where}` : ''}${b.program ? ` (${b.program})` : ''}`
        })
        .join('; ')
      parts.push(`schedule: ${blockList}`)
    }

    return parts.join(' | ')
  })

  const holdLines = holds
    .filter((h) => !HIDDEN_TRUCKS.has(h.truck_number))
    .map((h) => {
      const start = h.start_date.toISOString().split('T')[0]
      const end   = h.end_date.toISOString().split('T')[0]
      return `  Truck ${h.truck_number}: ${h.status} for "${h.client_name}" in ${h.market}${h.state ? ', ' + h.state : ''} (${start} → ${end})${h.notes ? ' — ' + h.notes : ''}`
    })

  return `TRUCK STATUS (today: ${today}; schedule window covers 30 days before through 60 days after today):
${truckLines.join('\n')}

ALL HOLDS & COMMITMENTS (${holds.length} total):
${holdLines.join('\n') || '  None'}`
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { message, history = [], conversation_id: incomingConvId } = await req.json()
  if (!message) {
    return NextResponse.json({ error: 'Message required' }, { status: 400 })
  }

  // ── Resolve or create conversation ─────────────────────────────────────────
  let convId: string | null = incomingConvId ?? null

  try {
    if (!convId) {
      const title = message.slice(0, 60)
      const [newConv] = await query<Record<string, unknown>[]>(
        `INSERT INTO dbo.chat_conversations (id, title, user_id, created_at, updated_at)
         OUTPUT INSERTED.id
         VALUES (NEWID(), @title, @userId, GETUTCDATE(), GETUTCDATE())`,
        { title, userId: session.user.id }
      )
      convId = String(newConv.id)
    } else {
      const [conv] = await query<Record<string, unknown>[]>(
        `SELECT id FROM dbo.chat_conversations WHERE id = @convId AND user_id = @userId`,
        { convId, userId: session.user.id }
      )
      if (!conv) convId = null // fall through without persistence if stale id
    }

    if (convId) {
      await query(
        `INSERT INTO dbo.chat_messages (id, conversation_id, role, content, created_at)
         VALUES (NEWID(), @convId, 'user', @content, GETUTCDATE())`,
        { convId, content: message }
      )
    }
  } catch (err) {
    console.error('Failed to persist user message:', err)
    convId = null
  }

  // ── Build schedule context ────────────────────────────────────────────────
  let scheduleContext: string
  try {
    scheduleContext = await buildScheduleContext()
  } catch (err) {
    console.error('Failed to build schedule context:', err)
    scheduleContext = 'Schedule data temporarily unavailable.'
  }

  const messages: Anthropic.MessageParam[] = [
    ...history.map((msg: { role: string; content: string }) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    })),
    {
      role: 'user',
      content: `${message}\n\n[SCHEDULE DATA]\n${scheduleContext}`,
    },
  ]

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    system: BASE_SYSTEM_PROMPT,
    messages,
  })

  const rawReply = response.content[0].type === 'text' ? response.content[0].text : ''

  // ── Parse & execute any action block ───────────────────────────────────────
  const action = parseAction(rawReply)
  const reply  = action ? stripAction(rawReply) : rawReply

  let actionResult: ActionResult | null = null
  if (action) {
    try {
      if (action.type === 'PLACE_HOLD') {
        actionResult = await executePlaceHold(action.fields, session.user.id)
      } else if (action.type === 'RELEASE_HOLD') {
        actionResult = await executeReleaseHold(action.fields, session.user.id)
      }
    } catch (err) {
      console.error('Action execution error:', err)
      actionResult = { success: false, message: 'Action failed due to a server error.' }
    }
  }

  // ── Persist assistant reply ─────────────────────────────────────────────────
  if (convId) {
    try {
      await query(
        `INSERT INTO dbo.chat_messages (id, conversation_id, role, content, created_at)
         VALUES (NEWID(), @convId, 'assistant', @content, GETUTCDATE())`,
        { convId, content: reply }
      )
      if (actionResult) {
        await query(
          `INSERT INTO dbo.chat_messages (id, conversation_id, role, content, created_at)
           VALUES (NEWID(), @convId, 'assistant', @content, GETUTCDATE())`,
          { convId, content: actionResult.message }
        )
      }
      await query(
        `UPDATE dbo.chat_conversations SET updated_at = GETUTCDATE() WHERE id = @convId`,
        { convId }
      )
    } catch (err) {
      console.error('Failed to persist assistant reply:', err)
    }
  }

  return NextResponse.json({ reply, actionResult, conversation_id: convId })
}

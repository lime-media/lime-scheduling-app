import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import Anthropic from '@anthropic-ai/sdk'
import { query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { CHAT_CONTEXT_QUERY } from '@/lib/scheduleQuery'
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
- Always include specific truck numbers in your answers, never just counts
- When asked "how many trucks in X" → give the count AND list every truck number
- When asked about availability → list which trucks are free AND which are not
- When asked about a specific truck → give its full current status, market, program, dates, and last known GPS location
- When asked about a date range → check every day in that range, flag any gaps
- When asked about conflicts → identify the exact overlap with truck numbers and dates
- Be direct and concise — lead with the answer, then give detail
- Always reference today's date when answering relative questions like "this week", "next week", "today"
- If the data doesn't contain enough information to answer confidently, say so clearly and explain what's missing
- Never make up or estimate data — only answer from what's provided
- CRITICAL: Never guess or assume a truck's location. Only state a truck's market/location if it appears explicitly in the data provided. If a truck has no GPS data and no schedule, say "location unknown" — do not infer or guess its location from other trucks or patterns.

RESPONSE FORMAT — mandatory, do not deviate:

For any question involving truck assignments, event planning, or availability across one or more events/locations — output structured [EVENT] blocks, one per event or location. The UI will render these as styled cards.

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

For simple factual questions (single truck lookup, quick counts, yes/no, hold status) — answer in 2–4 lines of plain text without any [EVENT] blocks. No markdown, no bold, no tables.

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
Today's date is always provided in the schedule context.`

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

  // Conflict check
  const conflicts = await prisma.hold.findMany({
    where: {
      truck_number: truck,
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

const HIDDEN_TRUCKS = new Set(['0001'])

async function buildScheduleContext(): Promise<string> {
  const today = new Date().toISOString().split('T')[0]

  const [truckRows, holds, gpsMap] = await Promise.all([
    query<Record<string, unknown>[]>(CHAT_CONTEXT_QUERY),
    prisma.hold.findMany({
      include: { user: { select: { name: true } } },
      orderBy: { start_date: 'asc' },
    }),
    getLiveVehicleLocations().catch(() => new Map<string, { formatted_address: string; city: string; state: string }>()),
  ])

  const trucks = (truckRows as Record<string, string>[]).filter(
    (r) => !HIDDEN_TRUCKS.has(r.truck_number)
  )

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
    if (r.program)        parts.push(`program="${r.program}"`)
    if (r.market)         parts.push(`market=${r.market}`)
    if (r.schedule_start) parts.push(`scheduled ${r.schedule_start} → ${r.schedule_end}`)
    return parts.join(' | ')
  })

  const holdLines = holds
    .filter((h) => !HIDDEN_TRUCKS.has(h.truck_number))
    .map((h) => {
      const start = h.start_date.toISOString().split('T')[0]
      const end   = h.end_date.toISOString().split('T')[0]
      return `  Truck ${h.truck_number}: ${h.status} for "${h.client_name}" in ${h.market}${h.state ? ', ' + h.state : ''} (${start} → ${end})${h.notes ? ' — ' + h.notes : ''}`
    })

  return `TRUCK STATUS (today: ${today}):
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

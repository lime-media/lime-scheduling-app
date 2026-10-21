import { withUsageLog } from '@/lib/usageLog'
import { addMessages, openConversation } from '@/lib/conversations'
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import Anthropic from '@anthropic-ai/sdk'
import { query } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere } from '@/lib/holdFilters'
import { CHAT_CONTEXT_QUERY, CHAT_SCHEDULE_WINDOW_QUERY } from '@/lib/scheduleQuery'
import { getLiveVehicleLocations } from '@/lib/samsaraService'
import { formatMarketState } from '@/lib/format'
import { HIDDEN_TRUCKS } from '@/lib/hiddenTrucks'
import { CHAT_TOOLS, runChatTool, type ChatToolContext } from '@/lib/staffChatTools'
import { CLOSED_WON_READ_ONLY, bookingKey, closedWonRefusal } from '@/lib/bookings'
import { loadBookingHolds } from '@/lib/bookingLoad'
import { getOpportunityStage } from '@/lib/sfdcOpportunityReconcile'
import { syncOpportunityLedWindow } from '@/lib/sfdcBooking'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── System prompt ────────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are the Lime Media Scheduling Assistant — an intelligent operations assistant for the Lime Media truck scheduling team.

You have the live schedule (provided with every message) and tools that run the app's own engine: check_availability, get_quote, find_account, find_contacts, place_hold and release_hold. They work exactly like the Quote page, so what you quote and book is what the Quote page would quote and book.

STATUS MEANINGS:
- AVAILABLE (grey): No scheduled program, no hold
- SCHEDULED (green): Assigned to a client program in the LED app
- HOLD (yellow): Reserved for a client
- ATT_SOFT (blue): Soft hold reserved for AT&T — gives way only on the specific days another client's program is booked on that truck; the rest of the hold stands

ANSWER RULES — ALWAYS follow these:
- Be concise by default. Lead with the direct answer in a sentence or two. Only add supporting detail (client/program name, exact date ranges, GPS movement history) when the user explicitly asks for it, or when it's necessary to justify a recommendation.
- Always include specific truck numbers in your answers, never just counts
- When asked "how many trucks in X" → give the count AND list every truck number
- When asked about availability for a market and dates → call check_availability and answer from it: which trucks can take it, nearest first, and which can't and why. Do not dump a full day-by-day schedule unless asked
- When asked something like "is there a truck near/available for market X" → call check_availability and name the nearest truck that can take it, with its distance. That's the answer, not a rundown of every truck's schedule
- Distances, transport, prices and which trucks a booking gets come only from the tools. Never estimate them yourself from GPS or the schedule
- When asked about a specific truck's current location/status → answer in one or two sentences: current market and status. Don't narrate how it got there or where it's been (e.g. "it's bouncing around the Midwest"), and don't mention which client/program it's booked for unless explicitly asked — just say SCHEDULED/HOLD/etc. and the market
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
- End the prose with a one-line summary of ATT_SOFT/hold conflicts across all recommended trucks, then say how to book it (see BOOKING)

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
- One "truck" line per assigned truck: "truck: NUMBER | City, ST | ~XXX mi" — the truck, where it's released from and its miles, all from check_availability or get_quote
- Optional "note" line: use for blocked trucks, warnings, or relevant context — keep it one sentence
- No markdown inside [EVENT] blocks. Plain text only.
- Output one [EVENT] block per event, back to back, with no extra text between them

For single-truck lookups and simple yes/no availability questions — answer in 1-3 short sentences: current status, market, and whether it's near/available for whatever was asked. Skip client/program names, exact dates, and GPS movement history unless the user explicitly asks for that detail. [EVENT] blocks aren't needed here unless the user is assigning or holding a truck.

PRICES:
- Quote only with get_quote, and give its numbers as they are (grandTotal, media, features, transport). Never compute or adjust a price yourself.
- When you show a quote the rep could book, include its line "Quote ref: Q-XXXXXXXX" (the quote_ref get_quote returned).

BOOKING (one market at a time):
1. Gather the market, dates, truck count and features. For a booking you also need the Salesforce account (find_account) and the opportunity's primary contact (find_contacts). Ask for whichever are missing; if a search finds several, ask which.
2. Run get_quote with the account and the booking terms (account name, primary contact, brand if given, hold days, default 3, and stage, default WARM). Show the quote (total, trucks, transport) and those terms with its quote ref, and ask the rep to confirm. The ref covers all of it: place_hold must pass the same values.
3. Only when the rep confirms in their next message, call place_hold with the same inputs, the quote_ref and the grandTotal. place_hold books only the quote ref in your previous reply, so the reply that asks for confirmation must show the quote with its ref (if you asked something else in between, show the quote and its ref again). If anything changes, quote again and ask again.
4. Report what place_hold returned, including any Salesforce problem. Never describe a refused or partial booking as done.
- A campaign across several markets is one booking with one quote and one expiry: check availability per market here, but price and book it on the Multi-market planner. Single-market quotes don't add up to its price.
- Adding to an existing opportunity, or logging a quote without reserving trucks, is done on the Quote page.

RELEASING: release_hold releases one hold by its id from the HOLDS list, one per message. Name the hold (truck, client, dates) with its id in brackets and ask the rep to confirm; call it only when they confirm in their next message. It's refused unless that id was in your previous reply. Committed (Closed Won) and AT&T soft holds can't be released here.

Today's date is always provided in the schedule context. Truck schedule data covers a fixed window from 30 days before today through 60 days after today — if asked about a date outside that window, say so explicitly rather than guessing.`

// ── Release ─────────────────────────────────────────────────────────────────

type ActionResult = { success: boolean; message: string }

async function executeReleaseHold(
  holdId: unknown,
  userId: string
): Promise<ActionResult> {
  // By id only: picking "the truck's next hold" could release the wrong one
  // (an AT&T soft hold, or another client's).
  const hold = typeof holdId === 'string' && holdId
    ? await prisma.hold.findFirst({ where: { id: holdId, ...activeHoldWhere() } })
    : null

  if (!hold) {
    return { success: false, message: 'No active hold with that id.' }
  }
  // AT&T soft holds give way through their own release flow (lib/attSoftRelease.ts), not a delete.
  if (hold.status === 'ATT_SOFT') {
    return { success: false, message: `Truck ${hold.truck_number}'s hold is an AT&T soft hold; release it from the AT&T soft-hold controls.` }
  }
  // A booking is the unit (lib/bookings.ts): one truck of a campaign group or
  // opportunity is never released on its own. The whole booking is cancelled
  // from Reservations, which also emails the client.
  const key = bookingKey(hold)
  const booking = key ? await loadBookingHolds(key) : []
  const others = booking.filter(h => h.id !== hold.id && h.status !== 'EXPIRED')
  if (others.length) {
    return { success: false, message: `Truck ${hold.truck_number}'s hold is one of ${others.length + 1} in a booking for "${hold.client_name}"; a booking is released whole, from Reservations (Cancel).` }
  }
  // A won deal is never released from here (lib/bookings.ts closedWonRefusal),
  // including in the minutes before the reconcile commits it.
  const stage = hold.sfdc_opportunity_id ? await getOpportunityStage(hold.sfdc_opportunity_id) : null
  if (closedWonRefusal([hold, ...booking], stage?.isClosed ? { isWon: stage.isWon } : null)) {
    return { success: false, message: `Truck ${hold.truck_number} is committed to "${hold.client_name}". ${CLOSED_WON_READ_ONLY}` }
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
  // Salesforce's LED Trucks and Hold Exp follow the release (lib/sfdcBooking.ts syncOpportunityLedWindow).
  const sfdcWarning = await syncOpportunityLedWindow(hold.sfdc_opportunity_id)

  return {
    success: true,
    message: `Released ${hold.status} hold on truck ${hold.truck_number} for "${hold.client_name}" (${hold.start_date.toISOString().split('T')[0]} – ${hold.end_date.toISOString().split('T')[0]}).`
      + (sfdcWarning ? ` ${sfdcWarning}` : ''),
  }
}

// ── Context builder ───────────────────────────────────────────────────────────

async function buildScheduleContext(): Promise<string> {
  const today = new Date().toISOString().split('T')[0]

  const [truckRows, windowRows, holds, gpsMap] = await Promise.all([
    query<Record<string, unknown>[]>(CHAT_CONTEXT_QUERY),
    query<Record<string, unknown>[]>(CHAT_SCHEDULE_WINDOW_QUERY),
    // Released holds — status EXPIRED, or expires_at already passed — don't tell
    // the assistant a truck is held by one
    prisma.hold.findMany({
      where: activeHoldWhere(),
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
          const where = formatMarketState(b.market, b.state)
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
      return `  [${h.id}] Truck ${h.truck_number}: ${h.status} for "${h.client_name}" in ${h.market}${h.state ? ', ' + h.state : ''} (${start} → ${end})${h.notes ? ' — ' + h.notes : ''}`
    })

  return `TRUCK STATUS (today: ${today}; schedule window covers 30 days before through 60 days after today):
${truckLines.join('\n')}

HOLDS (id in brackets; ${holds.length} total, including committed and AT&T soft holds):
${holdLines.join('\n') || '  None'}`
}

// ── Route handler ─────────────────────────────────────────────────────────────

/** Tool rounds per message: enough to find an account, its contact, check and quote. */
const MAX_TOOL_ROUNDS = 8

/** A release's result for the model; `shownToRep` false for a refusal the model must act on, not a release the rep sees. */
function releaseOutcome(r: ActionResult, shownToRep = true) {
  return { content: JSON.stringify(r), isError: !r.success, action: shownToRep ? r : undefined }
}

// Several tool rounds on Opus can run past the default limit.
export const maxDuration = 300

async function handlePost(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { message, history: rawHistory, conversation_id: incomingConvId } = await req.json()
  if (typeof message !== 'string' || !message.trim()) {
    return NextResponse.json({ error: 'Message required' }, { status: 400 })
  }
  // Only text turns with content (the API rejects an empty one), starting with
  // the rep's: a history cut to its last 10 can start on a reply.
  const history: { role: 'user' | 'assistant'; content: string }[] = (Array.isArray(rawHistory) ? rawHistory : [])
    .filter((m: unknown): m is { role: string; content: string } => !!m && typeof m === 'object' && typeof (m as { content?: unknown }).content === 'string' && !!(m as { content: string }).content.trim())
    .map((m: { role: string; content: string }) => ({ role: m.role === 'assistant' ? 'assistant' as const : 'user' as const, content: m.content }))
  // What the rep is confirming: the reply just before this message (the
  // assistant turns after their last one), before any trim. Only a quote ref in
  // it can be booked, so an older quote, or one already booked, can't be
  // booked again by a later "yes" or a retried message.
  const lastUser = history.map(m => m.role).lastIndexOf('user')
  const shown = history.slice(lastUser + 1).map(m => m.content).join('\n')
  while (history.length && history[0].role === 'assistant') history.shift()

  // ── The conversation this message belongs to (lib/conversations.ts) ──────
  const convId = await openConversation({ actorType: 'app_user', userId: session.user.id }, incomingConvId, message)
  await addMessages(convId, [{ role: 'user', content: message }])

  // ── Build schedule context ────────────────────────────────────────────────
  let scheduleContext: string
  try {
    scheduleContext = await buildScheduleContext()
  } catch (err) {
    console.error('Failed to build schedule context:', err)
    scheduleContext = 'Schedule data temporarily unavailable.'
  }

  const messages: Anthropic.MessageParam[] = [
    ...history,
    {
      role: 'user',
      // Cached too: every tool round resends the whole schedule.
      content: [{ type: 'text', text: `${message}\n\n[SCHEDULE DATA]\n${scheduleContext}`, cache_control: { type: 'ephemeral' } }],
    },
  ]

  // ── Run the tools until the model answers (lib/staffChatTools.ts) ─────────
  const ctx: ChatToolContext = {
    actor: { type: 'app_user', id: session.user.id, name: session.user.name ?? session.user.email ?? '', email: session.user.email },
    shownText: shown,
    booked: false,
    conversationId: convId,
  }
  // A release, like a booking, needs the rep's confirmation: the hold's id in
  // the reply they're answering, and one per message.
  let released = false
  const release = async (holdId: unknown) => {
    if (released) return releaseOutcome({ success: false, message: 'One release per message. Ask the rep before releasing another hold.' }, false)
    if (typeof holdId !== 'string' || !holdId || !shown.includes(holdId)) {
      return releaseOutcome({ success: false, message: 'Name this hold with its id and ask the rep to confirm first; release it when they reply.' }, false)
    }
    released = true
    return releaseOutcome(await executeReleaseHold(holdId, session.user.id))
  }
  const actions: ActionResult[] = []
  const quotes: { ref: string; summary: string }[] = []
  let reply = ''
  for (let round = 0; ; round++) {
    const response = await anthropic.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      // Same prompt and tools every request, so they're cached.
      system: [{ type: 'text', text: BASE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: CHAT_TOOLS,
      messages,
    })
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('\n\n')
      .trim()
    if (response.stop_reason === 'refusal') {
      reply = text || "I can't help with that request."
      break
    }
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    // A cut-off tool call (max_tokens) is never run.
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      reply = text
      break
    }
    if (round >= MAX_TOOL_ROUNDS) {
      // Text beside a tool call is narration ("Let me check…"), not an answer.
      reply = "I stopped before finishing: that took more steps than I'm allowed in one message. Ask again more narrowly."
      break
    }
    messages.push({ role: 'assistant', content: response.content })
    // One at a time, in order: a booking must never run beside another.
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const use of toolUses) {
      let out
      try {
        out = use.name === 'release_hold'
          ? await release((use.input as { hold_id?: unknown }).hold_id)
          : await runChatTool(use.name, use.input, ctx)
      } catch (err) {
        console.error(`[chat] ${use.name} failed:`, err)
        out = { content: JSON.stringify({ error: 'Server error' }), isError: true, action: ['place_hold', 'release_hold'].includes(use.name) ? { success: false, message: 'Action failed due to a server error.' } : undefined }
      }
      if (out.action) actions.push(out.action)
      if ('quote' in out && out.quote) quotes.push(out.quote)
      results.push({ type: 'tool_result', tool_use_id: use.id, content: out.content, is_error: out.isError })
    }
    messages.push({ role: 'user', content: results })
  }

  // An empty reply would be sent back as an empty history turn, which the API rejects.
  if (!reply && !actions.length) reply = 'Sorry, I could not answer that. Please try asking again.'
  // A bookable quote is always shown with its ref, so the rep's "yes" can book it.
  // One booked this message isn't offered again.
  const missing = quotes.filter(q => q.ref !== ctx.bookedRef && !reply.includes(q.ref))
  if (missing.length) reply += `\n\n${missing.map(q => `Quote ref: ${q.ref} (${q.summary})`).join('\n')}`
  const actionResult: ActionResult | null = actions.length
    ? { success: actions.every(a => a.success), message: actions.map(a => a.message).join(' ') }
    : null

  // ── Persist the reply ────────────────────────────────────────────────────
  await addMessages(convId, [
    ...(reply ? [{ role: 'assistant' as const, content: reply }] : []),
    ...(actionResult ? [{ role: 'assistant' as const, content: actionResult.message }] : []),
  ])

  return NextResponse.json({ reply, actionResult, conversation_id: convId })
}

// Every run is logged for the Usage page (lib/usageLog.ts).
export const POST = withUsageLog('ai_chat_staff', 'staff', handlePost)

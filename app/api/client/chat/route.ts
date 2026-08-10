import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { query } from '@/lib/mssql'
import { getClientSession, type ClientSession } from '@/lib/clientAuth'
import { buildClientChatContext } from '@/lib/clientChatContext'
import { createHoldRequestForClient, type CreateHoldRequestParams } from '@/lib/holdRequestService'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── System prompt ────────────────────────────────────────────────────────────
// Deliberately separate from the internal assistant's BASE_SYSTEM_PROMPT (app/api/chat/route.ts)
// — that one is written for trusted staff with full visibility across every client and can place
// holds. This one is scoped to a single client, read-only, and treats data isolation as the
// top-priority rule, not an afterthought.

function buildClientSystemPrompt(companyName: string): string {
  return `You are the Lime Media client portal assistant, speaking with ${companyName}.

CRITICAL — DATA ISOLATION. Read this before anything else:
- You may ONLY discuss ${companyName}'s own account: their own hold requests, and general truck availability (whether a truck/date is open or already booked).
- You have ZERO information about any other client's identity — the data you're given never contains another client's name, company, or account details, by design. Do not guess, infer, speculate, or make one up under any circumstance.
- If a truck is booked/unavailable, you may say so and give the destination market and dates — but NEVER say or imply who booked it, never guess a company name or industry, and never mention any brand name (including AT&T) even if a pattern seems familiar to you.
- If asked who else uses this platform, which other clients have trucks booked, to compare them to another company, or anything about another client's identity or activity — decline clearly and briefly, and redirect to what you can help with (their own availability and hold requests). Do not soften this into a partial answer.
- Never fabricate a company name, ever, for any reason.

CRITICAL — VISIBILITY LIMIT. The data below states an exact date through which the LED schedule is actually populated. Past that date, "not listed as booked" does NOT mean available — it means you have no data either way. Never answer an availability question for a date past that limit by listing trucks as available; say plainly that you don't have visibility that far out yet and can't confirm, and suggest they check back closer to the date or contact the Lime Media team directly. This applies even if the requested date is otherwise close to dates you can confirm — check every date against the limit before answering, not just the first one.

WHAT YOU CAN HELP WITH:
- "Tell me about the holds we've placed" / "my hold requests" → list every one of ${companyName}'s own hold requests from the data below: truck number, market/state, dates, status (PENDING/APPROVED/REJECTED), and notes if present.
- Availability questions ("is truck X free on Y", "can I get N trucks in city Z from A to B") → check each truck's booked ranges ONLY against the exact requested start/end date, then answer in exactly two short lists, nothing else:
  1. "Available for your full date range:" — every truck with ZERO booked ranges overlapping the requested window, even partially. A booking anywhere else on the calendar — before it, after it, a week away, a day away — is irrelevant and must NEVER be mentioned, hinted at, or added as a caveat/aside/"heads up" for a truck in this list. If there's no overlap, that truck belongs here with nothing else said about it. Just the truck numbers, one line, no more.
     Example: requested window is Sep 1–5. A truck's nearest booking is Sep 21–27. That truck is fully available for Sep 1–5 — it goes in list 1, full stop. Do not mention the Sep 21–27 booking anywhere in the answer.
  2. "A few other options near your dates:" — only trucks whose booked range ACTUALLY OVERLAPS part of the requested window (available for the remainder of it), each as one short line naming just the open sub-range (e.g. "Truck 0783 — available from Aug 15"). Only include this list if list 1 is thin or empty.
  Do NOT explain a truck's full booking history, when its last booking ended, what other cities it's booked in, or walk through your reasoning for each truck — the client only needs to know what's open, not the calendar detail behind it. If NOTHING is available at all, say so plainly and stop; don't pad the answer with unavailable trucks and their booking details.
- Ground every answer in the data provided below. If something isn't in the data, say you don't have that information rather than guessing.
- Keep every answer short and scannable. No walls of text, no restating the same fact multiple ways.
- Be concise and direct. Plain sentences or short bullet lists — no markdown tables needed.

TAKING ACTION — submitting hold requests:
- You can submit hold requests on ${companyName}'s behalf when asked and confirmed. You can only ever create a REQUEST (status PENDING) — never a confirmed booking. Every request still goes through the same Lime Media team review as one submitted by dragging on the Schedule Grid; nothing you submit is ever auto-approved.
- Only offer to submit for trucks you've already shown as available in THIS conversation, for the exact dates being discussed. Never invent availability or submit for a truck you haven't verified against the data.
- Workflow:
  1. When the client asks to hold/book/reserve trucks, first answer with availability (per the rules above) if you haven't already, then state exactly what you're about to submit — truck numbers, market/state, start and end dates — and ask them to confirm.
  2. Only submit after a clear confirmation in this message or the immediately prior one ("yes", "go ahead", "submit those", "do it"). A vague or unrelated reply is not confirmation — ask again rather than guess.
  3. Once confirmed, append this block at the very end of your reply, one line per truck, using the exact dates just confirmed:
[ACTION: PLACE_HOLD_REQUESTS]
truck: <truck_number> | market: <City, ST> | state: <2-letter state> | start: <YYYY-MM-DD> | end: <YYYY-MM-DD>
[/ACTION]
  - Never emit this block without an explicit confirmation first.
  - Only include the trucks the client actually confirmed — never pad the list.
  - No markdown inside the block. Plain text only.`
}

// ── Action block parsing & execution ─────────────────────────────────────────
// Mirrors the internal assistant's [ACTION: ...] pattern (app/api/chat/route.ts), but scoped to
// the one action a client is allowed to take: creating their own PENDING HoldRequest rows via
// the same shared service the manual Schedule Grid submission uses. There is no equivalent of
// the internal assistant's PLACE_HOLD (a confirmed Hold) or RELEASE_HOLD here — clients never
// get that capability, staff-only review still gates every request.

const ACTION_RE = /\[ACTION:\s*PLACE_HOLD_REQUESTS\]([\s\S]*?)\[\/ACTION\]/
const MAX_HOLD_REQUESTS_PER_TURN = 20

function stripActionBlock(text: string): string {
  return text.replace(ACTION_RE, '').trim()
}

function parseHoldRequestLines(body: string): CreateHoldRequestParams[] {
  return body
    .trim()
    .split('\n')
    .filter((line) => line.trim().toLowerCase().startsWith('truck:'))
    .map((line) => {
      const fields: Record<string, string> = {}
      for (const part of line.split('|')) {
        const colon = part.indexOf(':')
        if (colon === -1) continue
        const k = part.slice(0, colon).trim().toLowerCase()
        const v = part.slice(colon + 1).trim()
        if (k && v) fields[k] = v
      }
      return {
        truck_number: fields.truck  ?? '',
        market:       fields.market ?? '',
        state:        fields.state  ?? '',
        start_date:   fields.start  ?? '',
        end_date:     fields.end    ?? '',
      }
    })
    .filter((p) => p.truck_number && p.start_date && p.end_date)
}

async function executePlaceHoldRequests(
  actionBody: string,
  session: ClientSession
): Promise<{ success: boolean; message: string }> {
  const items = parseHoldRequestLines(actionBody)
  if (items.length === 0) {
    return { success: false, message: 'No valid hold request details found — nothing was submitted.' }
  }
  if (items.length > MAX_HOLD_REQUESTS_PER_TURN) {
    return { success: false, message: `That's ${items.length} trucks at once — please ask for ${MAX_HOLD_REQUESTS_PER_TURN} or fewer per request.` }
  }

  const created: string[] = []
  const failed:  string[] = []
  for (const item of items) {
    try {
      await createHoldRequestForClient(session, item)
      created.push(item.truck_number)
    } catch (err) {
      console.error('[client/chat] failed to create hold request:', err)
      failed.push(item.truck_number)
    }
  }

  if (created.length === 0) {
    return { success: false, message: "Sorry, I couldn't submit that — please try again or use the Schedule Grid directly." }
  }

  const truckList = created.map((t) => `#${t}`).join(', ')
  let message = `Submitted ${created.length} hold request${created.length > 1 ? 's' : ''} for review: ${truckList}. The Lime Media team will review ${created.length > 1 ? 'them' : 'it'} from here.`
  if (failed.length > 0) {
    message += ` (Couldn't submit for ${failed.map((t) => `#${t}`).join(', ')} — please try those again.)`
  }
  return { success: true, message }
}

// ── Output guardrail ─────────────────────────────────────────────────────────
// Defense in depth: even though the context passed to the model never includes another
// client's name, this catches anything that could slip through — a model mistake, a future
// change to buildClientChatContext that accidentally widens what's included, etc. If the
// reply matches any other client's identifier, it never reaches the browser.

const HARDCODED_NEEDLES = ['AT&T', 'ATT_SOFT'] // the one internal hold status that itself names a client

async function scrubOtherClientNames(reply: string, ownClientId: string): Promise<string> {
  const others = await prisma.clientUser.findMany({
    where:  { id: { not: ownClientId } },
    select: { company_name: true },
  })
  // Only company_name is checked — that's the actual identity signal ("their name" per the
  // requirement this guardrail exists for). Usernames are excluded: they're never in the model's
  // context to begin with (this scrub is a backstop, not the primary defense), and some are
  // generic login handles ("test") that collide with ordinary English words in a normal reply.
  // A short stopword list guards against the same problem for company_name, in case a future
  // test/seed account is named something equally generic (e.g. the "test2" seed account below).
  const STOPWORDS = new Set(['test', 'demo', 'sample', 'none', 'staff', 'admin', 'client', 'other'])
  const needles = [
    ...HARDCODED_NEEDLES,
    ...others.map((c) => c.company_name),
  ].filter((s) => s && s.trim().length >= 4 && !STOPWORDS.has(s.trim().toLowerCase()))

  const lowerReply = reply.toLowerCase()
  for (const needle of needles) {
    if (lowerReply.includes(needle.toLowerCase())) {
      console.warn('[client/chat] blocked reply — matched another client identifier:', needle)
      return "Sorry, I can't share that — I can only give you information about your own account. Ask me about your hold requests or truck availability."
    }
  }
  return reply
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { message, history = [], conversation_id: incomingConvId } = await req.json()
  if (!message) return NextResponse.json({ error: 'Message required' }, { status: 400 })

  // ── Resolve or create conversation ─────────────────────────────────────────
  // Same pattern as the internal assistant's persistence in app/api/chat/route.ts, scoped to
  // client_user_id instead of the staff user_id — separate tables entirely (see
  // lib/clientChatContext.ts comment / conversation with the user for why).
  let convId: string | null = incomingConvId ?? null

  try {
    if (!convId) {
      const title = String(message).slice(0, 60)
      const [newConv] = await query<Record<string, unknown>[]>(
        `INSERT INTO dbo.client_chat_conversations (id, title, client_user_id, created_at, updated_at)
         OUTPUT INSERTED.id
         VALUES (NEWID(), @title, @clientId, SYSUTCDATETIME(), SYSUTCDATETIME())`,
        { title, clientId: session.id }
      )
      convId = String(newConv.id)
    } else {
      const [conv] = await query<Record<string, unknown>[]>(
        `SELECT id FROM dbo.client_chat_conversations WHERE id = @convId AND client_user_id = @clientId`,
        { convId, clientId: session.id }
      )
      if (!conv) convId = null // stale/foreign id — fall through without persistence rather than error
    }

    if (convId) {
      await query(
        `INSERT INTO dbo.client_chat_messages (id, conversation_id, role, content, created_at)
         VALUES (NEWID(), @convId, 'user', @content, SYSUTCDATETIME())`,
        { convId, content: message }
      )
    }
  } catch (err) {
    console.error('[client/chat] failed to persist user message:', err)
    convId = null
  }

  let context: string
  try {
    context = await buildClientChatContext(session)
  } catch (err) {
    console.error('[client/chat] context build failed:', err)
    context = 'Account data temporarily unavailable.'
  }

  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-10).map((m: { role: string; content: string }) => ({
      role:    m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: m.content,
    })),
    { role: 'user', content: `${message}\n\n[ACCOUNT DATA]\n${context}` },
  ]

  let reply: string
  try {
    const response = await anthropic.messages.create({
      model:      'claude-opus-4-6',
      max_tokens: 1024,
      system:     buildClientSystemPrompt(session.companyName),
      messages,
    })
    reply = response.content[0]?.type === 'text' ? response.content[0].text : ''
  } catch (err) {
    console.error('[client/chat] Anthropic call failed:', err)
    return NextResponse.json({ error: 'Assistant is temporarily unavailable.' }, { status: 502 })
  }

  // ── Parse & execute any action block ───────────────────────────────────────
  // Done on the RAW reply, before scrubbing — the block is structured data (truck/market/date
  // fields), not prose, and stripping it first keeps the scrub focused purely on the natural-
  // language answer.
  const actionMatch = reply.match(ACTION_RE)
  reply = actionMatch ? stripActionBlock(reply) : reply
  reply = await scrubOtherClientNames(reply, session.id)

  let actionResult: { success: boolean; message: string } | null = null
  if (actionMatch) {
    try {
      actionResult = await executePlaceHoldRequests(actionMatch[1], session)
    } catch (err) {
      console.error('[client/chat] action execution failed:', err)
      actionResult = { success: false, message: 'Failed to submit your request due to a server error.' }
    }
  }

  // ── Persist assistant reply (+ action result, if any) ────────────────────────
  // Store the scrubbed reply — never the raw pre-scrub text — so a blocked reply never lands
  // in chat history either.
  if (convId) {
    try {
      await query(
        `INSERT INTO dbo.client_chat_messages (id, conversation_id, role, content, created_at)
         VALUES (NEWID(), @convId, 'assistant', @content, SYSUTCDATETIME())`,
        { convId, content: reply }
      )
      if (actionResult) {
        await query(
          `INSERT INTO dbo.client_chat_messages (id, conversation_id, role, content, created_at)
           VALUES (NEWID(), @convId, 'assistant', @content, SYSUTCDATETIME())`,
          { convId, content: actionResult.message }
        )
      }
      await query(
        `UPDATE dbo.client_chat_conversations SET updated_at = SYSUTCDATETIME() WHERE id = @convId`,
        { convId }
      )
    } catch (err) {
      console.error('[client/chat] failed to persist assistant reply:', err)
    }
  }

  return NextResponse.json({ reply, actionResult, conversation_id: convId })
}

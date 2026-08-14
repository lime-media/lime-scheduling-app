import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { getClientSession, type ClientSession } from '@/lib/clientAuth'
import { buildClientChatContext } from '@/lib/clientChatContext'
import { createHoldRequestForClient, type CreateHoldRequestParams } from '@/lib/holdRequestService'
import { sendAssistanceRequestEmail } from '@/lib/email'

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

AVAILABILITY RULE: a truck is available for a requested date whenever none of its booked ranges in the data below cover that date — this is true for near-term dates and far-future dates alike. A date with no LED schedule entered yet means the truck is genuinely open then, not unknown — never refuse to confirm availability, or hedge with "I don't have visibility that far out," just because a requested date is far in the future. Each truck's "last known market" (when listed) is your best signal for where an available truck is likely to be once its listed booked ranges run out — use it to judge whether a truck fits a requested city/market.

WHAT YOU CAN HELP WITH:
- "Tell me about the holds we've placed" / "my hold requests" → list every one of ${companyName}'s own hold requests from the data below: truck number, market/state, dates, status (PENDING/APPROVED/REJECTED), and notes if present.
- Availability questions ("is truck X free on Y", "can I get N trucks in city Z from A to B") → check each truck's booked ranges ONLY against the exact requested start/end date, per the availability rule above. Never mention truck numbers in the reply — the client needs counts and dates, not which specific truck; answer in exactly two short parts, nothing else:
  1. How many trucks have ZERO booked ranges overlapping the requested window, even partially — state the count plainly (e.g. "8 trucks are available for your full date range"). A booking anywhere else on the calendar — before it, after it, a week away, a day away — is irrelevant and must NEVER be mentioned, hinted at, or added as a caveat/aside/"heads up".
     Example: requested window is Sep 1–5. A truck's nearest booking is Sep 21–27. That truck counts as fully available for Sep 1–5, full stop. Do not mention the Sep 21–27 booking anywhere in the answer.
  2. Only if part 1's count is thin or zero, also mention how many trucks are available for PART of the window (booked range overlaps only partially) and when the earliest of those opens up (e.g. "a couple more open up starting Aug 15").
  Do NOT explain a truck's full booking history, when its last booking ended, what other cities it's booked in, or walk through your reasoning for each truck — the client only needs to know what's open, not the calendar detail behind it. If NOTHING is available at all, say so plainly and stop; don't pad the answer with unavailable trucks and their booking details.
- Multi-truck requests for a specific market ("can I get 3 trucks in Houston", "I need 5 trucks in Dallas from A to B") → first identify every truck available for the requested dates (per the availability rule above) whose last known market is that city. If that count meets or exceeds what was asked for, answer normally per the rule above (counts only, no truck numbers).
  If FEWER trucks are available in that exact market than requested, this is still a yes — never treat it as something you can't fulfill or as a reason to involve the team. State how many are available right in that market (a count only, never truck numbers — the client doesn't need those), then note that the rest will come from a nearby market, or possibly out-of-state, so pricing will vary accordingly for those. For example: "Yes, sure — we have 3 trucks available in Dallas for your dates. The remaining 2 you need will be driven in from another nearby market, and possibly out-of-state, so pricing will vary accordingly for those." One short paragraph.
  For the remaining trucks (the ones NOT in the requested market), do not elaborate — no "there are plenty of trucks available in X and surrounding states," no naming specific trucks or their markets, no quantities. A brief "yes, there are trucks available for those" is enough.
  Hold requests can still be submitted for all of them, in-market and the rest, the normal way once confirmed (see TAKING ACTION — submitting hold requests below) — truck numbers are picked internally when submitting, never something you need to show the client first.
- Ground every answer in the data provided below. If something isn't in the data, say you don't have that information rather than guessing.
- If asked how to contact/reach Lime Media, or to ask the team something you can't answer yourself from the data — never send them off to go find contact info on their own (no "check your portal," no "contact your account rep"). Tell them to just say what they need and you'll pass it straight to the team, and they'll hear back by email within 12-24 hours. See TAKING ACTION — requesting team assistance below for the mechanics.
- Keep every answer short and scannable. No walls of text, no restating the same fact multiple ways.
- Be concise and direct. Plain sentences or short bullet lists — no markdown tables needed.

TAKING ACTION — submitting hold requests:
- You can submit hold requests on ${companyName}'s behalf when asked and confirmed. You can only ever create a REQUEST (status PENDING) — never a confirmed booking. Every request still goes through the same Lime Media team review as one submitted by dragging on the Schedule Grid; nothing you submit is ever auto-approved.
- Only offer to submit for trucks you've already shown as available in THIS conversation, for the exact dates being discussed. Never invent availability or submit for a truck you haven't verified against the data.
- Workflow:
  1. When the client asks to hold/book/reserve trucks, first answer with availability (per the rules above) if you haven't already, then state exactly what you're about to submit — how many trucks, market/state, start and end dates — and ask them to confirm. Never name truck numbers here either; the client confirms a quantity and dates, not which specific truck.
  2. Only submit after a clear confirmation in this message or the immediately prior one ("yes", "go ahead", "submit those", "do it"). A vague or unrelated reply is not confirmation — ask again rather than guess.
  3. Once confirmed, append this block at the very end of your reply, one line per truck, using the exact dates just confirmed:
[ACTION: PLACE_HOLD_REQUESTS]
truck: <truck_number> | market: <City, ST> | state: <2-letter state> | start: <YYYY-MM-DD> | end: <YYYY-MM-DD>
[/ACTION]
  - Never emit this block without an explicit confirmation first.
  - Only include the trucks the client actually confirmed — never pad the list.
  - No markdown inside the block. Plain text only.

TAKING ACTION — requesting team assistance:
- This is your general "get a human involved" tool — use it any time the client wants to reach Lime Media or ask them something you can't handle yourself. Common cases: a question outside what you can answer from the data, or the client directly asking how to contact/reach the team. Do NOT use this for a cross-market multi-truck request (see the rule above) — that's a normal fulfillable answer, not something to escalate.
- This is informational only — it does not create a hold or any commitment, it just emails the team with the client's question or need. Make that distinction clear when relevant (e.g. alongside a hold request for whatever IS available).
- No separate yes/no confirmation step is needed here (unlike hold requests) — once the client has stated an actual question or need, that alone is enough to send it. If they've only asked "how do I contact you" without yet saying what they need, ask what they'd like relayed first, then send it as soon as they answer.
- Once you have an actual question/need to relay, append this block at the very end of your reply:
[ACTION: REQUEST_ASSISTANCE]
market: <City, ST — omit this line entirely if not relevant to the question>
state: <2-letter state — omit this line entirely if not relevant>
start: <YYYY-MM-DD — omit this line entirely if not relevant>
end: <YYYY-MM-DD — omit this line entirely if not relevant>
details: <the client's question or need, in plain language>
[/ACTION]
  - "details" is the only required line — market/state/start/end only apply when the question is actually about specific trucks/markets/dates.
  - Tell the client, once sent: you'll hear back from the Lime Media team by email within 12-24 hours.
  - No markdown inside the block. Plain text only.`
}

// ── Action block parsing & execution ─────────────────────────────────────────
// Mirrors the internal assistant's [ACTION: ...] pattern (app/api/chat/route.ts), but scoped to
// the two actions a client is allowed to take: creating their own PENDING HoldRequest rows via
// the same shared service the manual Schedule Grid submission uses, or emailing the team an
// informational assistance request. There is no equivalent of the internal assistant's PLACE_HOLD
// (a confirmed Hold) or RELEASE_HOLD here — clients never get that capability, staff-only review
// still gates every request.

const ACTION_RE = /\[ACTION:\s*(PLACE_HOLD_REQUESTS|REQUEST_ASSISTANCE)\]([\s\S]*?)\[\/ACTION\]/
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

  let message = `Submitted ${created.length} hold request${created.length > 1 ? 's' : ''} for review. The Lime Media team will review ${created.length > 1 ? 'them' : 'it'} from here.`
  if (failed.length > 0) {
    message += ` (${failed.length} couldn't be submitted — please try again.)`
  }
  return { success: true, message }
}

function parseAssistanceRequestFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of body.trim().split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const k = line.slice(0, colon).trim().toLowerCase()
    const v = line.slice(colon + 1).trim()
    if (k && v) fields[k] = v
  }
  return fields
}

async function executeRequestAssistance(
  actionBody: string,
  session: ClientSession
): Promise<{ success: boolean; message: string }> {
  const fields = parseAssistanceRequestFields(actionBody)
  if (!fields.details) {
    return { success: false, message: "Sorry, I couldn't send that request — no question or need was included." }
  }

  try {
    await sendAssistanceRequestEmail({
      companyName: session.companyName,
      market:      fields.market,
      state:       fields.state,
      startDate:   fields.start,
      endDate:     fields.end,
      details:     fields.details,
    })
  } catch (err) {
    console.error('[client/chat] failed to send assistance request email:', err)
    return { success: false, message: "Sorry, I couldn't reach the team right now — please try again." }
  }

  return { success: true, message: "I've sent this to the Lime Media team — you'll hear back by email within 12-24 hours." }
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

  const { message, history = [] } = await req.json()
  if (!message) return NextResponse.json({ error: 'Message required' }, { status: 400 })

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
    const [, actionType, actionBody] = actionMatch
    try {
      actionResult = actionType === 'REQUEST_ASSISTANCE'
        ? await executeRequestAssistance(actionBody, session)
        : await executePlaceHoldRequests(actionBody, session)
    } catch (err) {
      console.error('[client/chat] action execution failed:', err)
      actionResult = { success: false, message: 'Failed to submit your request due to a server error.' }
    }
  }

  // Flat, client-wise log of both sides of the exchange, for simple cross-client reporting.
  // Written here (not at question time) so question and answer land in the same row.
  // Non-fatal: a logging failure must never block the actual chat response.
  const answer = actionResult ? `${reply}\n\n${actionResult.message}` : reply
  prisma.clientAiQuestion.create({
    data: { client_user_id: session.id, company_name: session.companyName, question: message, answer },
  }).catch((err) => console.error('[client/chat] failed to log question/answer:', err))

  return NextResponse.json({ reply, actionResult })
}

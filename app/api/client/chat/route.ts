import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { getClientSession, type ClientSession } from '@/lib/clientAuth'
import { buildClientChatContext } from '@/lib/clientChatContext'
import { sendAssistanceRequestEmail } from '@/lib/email'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── System prompt ────────────────────────────────────────────────────────────
// Simplified: the chat is now conversational only. Quoting and hold placement
// are handled by direct API endpoints (POST /api/client/quote and
// POST /api/client/hold-requests). The AI answers questions, discusses
// availability, explains features, and relays team assistance requests.

function buildClientSystemPrompt(companyName: string): string {
  return `You are the Lime Media client portal assistant, speaking with ${companyName}.

CRITICAL — DATA ISOLATION. Read this before anything else:
- You may ONLY discuss ${companyName}'s own account: their own hold requests, and general truck availability (whether a truck/date is open or already booked).
- You have ZERO information about any other client's identity — the data you're given never contains another client's name, company, or account details, by design. Do not guess, infer, speculate, or make one up under any circumstance.
- If a truck is booked/unavailable, you may say so and give the destination market and dates — but NEVER say or imply who booked it, never guess a company name or industry, and never mention any brand name (including AT&T) even if a pattern seems familiar to you.
- If asked who else uses this platform, which other clients have trucks booked, to compare them to another company, or anything about another client's identity or activity — decline clearly and briefly, and redirect to what you can help with (their own availability and hold requests). Do not soften this into a partial answer.
- Never fabricate a company name, ever, for any reason.

AVAILABILITY RULE: a truck is available for a requested date whenever none of its booked ranges in the data below cover that date — this is true for near-term dates and far-future dates alike. A date with no LED schedule entered yet means the truck is genuinely open then, not unknown — never refuse to confirm availability, or hedge with "I don't have visibility that far out," just because a requested date is far in the future. Each truck's "last known market" (when listed) is your best signal for where an available truck is likely to be once its listed booked ranges run out — use it to judge whether a truck fits a requested city/market.

RIGOR REQUIREMENT — read before stating any count: even though you never display truck numbers to the client, you must still work out the real, specific trucks internally before saying a number out loud. Go through the truck list below, check each one's booked ranges against the exact requested dates and its last known market against the requested city, and only count a truck if it concretely passes both checks. Never state a count you haven't actually derived this way.

NEVER SHOW YOUR WORK — do the per-truck checking entirely to yourself; the client-facing reply must jump straight to the finished answer. Your reply must NEVER contain: a truck-by-truck list, any truck number, any truck's last-known market or booking history, or narration like "Let me check X." The client only ever sees the final result — never the reasoning trail.

WHAT YOU CAN HELP WITH:
- "Tell me about the holds we've placed" / "my hold requests" → list ${companyName}'s own hold requests from the data below.
- Availability questions → check truck booked ranges and provide counts. Never mention truck numbers.
- Questions about pricing features (shadow fencing, Smart Directional, Device ID Passback, lift studies) → explain what they are and how they work.
- Market recommendations or campaign planning advice.
- Answering general questions about Lime Media's LED truck advertising.

QUOTING AND HOLDS:
- Pricing quotes and hold placement are now handled directly through the quote form and interactive pricing card above this chat.
- If a client asks for a quote or wants to place a hold, direct them to use the "Get a quote" form at the top of the page — they can enter their market, dates, and truck count, then customize features and place a hold directly from the pricing card.
- You can still discuss pricing concepts, explain features, or help them understand their options conversationally.
- Do NOT attempt to generate prices, state dollar amounts, or submit holds yourself.

TAKING ACTION — requesting team assistance:
- This is your "get a human involved" tool — use it when the client wants to reach the Lime Media team or has a question you can't answer from the data.
- Once you have an actual question/need to relay, append this block at the very end of your reply:
[ACTION: REQUEST_ASSISTANCE]
market: <City, ST — omit if not relevant>
state: <2-letter state — omit if not relevant>
start: <YYYY-MM-DD — omit if not relevant>
end: <YYYY-MM-DD — omit if not relevant>
details: <the client's question or need, in plain language>
[/ACTION]
  - "details" is the only required line.
  - Tell the client: you'll hear back from the Lime Media team by email within 12-24 hours.
  - No markdown inside the block. Plain text only.

Keep every answer short and scannable. Be concise and direct.`
}

// ── Action block parsing ─────────────────────────────────────────────────────

const ACTION_RE = /\[ACTION:\s*REQUEST_ASSISTANCE\]([\s\S]*?)\[\/ACTION\]/

function stripActionBlock(text: string): string {
  return text.replace(ACTION_RE, '').trim()
}

function parseKeyValueLines(body: string): Record<string, string> {
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
  const fields = parseKeyValueLines(actionBody)
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

const HARDCODED_NEEDLES = ['AT&T', 'ATT_SOFT']

async function scrubOtherClientNames(reply: string, ownClientId: string): Promise<string> {
  const others = await prisma.clientUser.findMany({
    where:  { id: { not: ownClientId } },
    select: { company_name: true },
  })
  const STOPWORDS = new Set(['test', 'demo', 'sample', 'none', 'staff', 'admin', 'client', 'other'])
  const needles = [
    ...HARDCODED_NEEDLES,
    ...others.map((c) => c.company_name),
  ].filter((s) => s && s.trim().length >= 4 && !STOPWORDS.has(s.trim().toLowerCase()))

  for (const needle of needles) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\b${escaped}\\b`, 'i')
    if (re.test(reply)) {
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
  if (session.username !== 'testclient') return NextResponse.json({ error: 'Not available yet' }, { status: 403 })

  const { message, history = [] } = await req.json()
  if (!message) return NextResponse.json({ error: 'Message required' }, { status: 400 })

  let context: string
  try {
    const built = await buildClientChatContext(session)
    context = built.prompt
  } catch (err) {
    console.error('[client/chat] context build failed:', err)
    context = 'Account data temporarily unavailable.'
  }

  const userTurn = `${message}\n\n[ACCOUNT DATA]\n${context}`

  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-10).map((m: { role: string; content: string }) => ({
      role:    m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: m.content,
    })),
    { role: 'user', content: userTurn },
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

  // Parse & execute REQUEST_ASSISTANCE action block (the only action remaining)
  const actionMatch = reply.match(ACTION_RE)
  reply = actionMatch ? stripActionBlock(reply) : reply
  reply = await scrubOtherClientNames(reply, session.id)

  let actionResult: { success: boolean; message: string } | null = null
  if (actionMatch) {
    const [, actionBody] = actionMatch
    try {
      actionResult = await executeRequestAssistance(actionBody, session)
    } catch (err) {
      console.error('[client/chat] action execution failed:', err)
      actionResult = { success: false, message: 'Failed to submit your request due to a server error.' }
    }
  }

  // Log the exchange
  const answer = actionResult ? `${reply}\n\n${actionResult.message}` : reply
  try {
    await prisma.clientAiQuestion.create({
      data: { client_user_id: session.id, company_name: session.companyName, question: message, answer },
    })
  } catch (err) {
    console.error('[client/chat] failed to log question/answer:', err)
  }

  return NextResponse.json({ reply, actionResult })
}

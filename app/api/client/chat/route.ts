import { withUsageLog } from '@/lib/usageLog'
import { addMessages, openConversation } from '@/lib/conversations'
import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { servedText, servedToolUses } from '@/lib/claudeReply'
import { prisma } from '@/lib/prisma'
import { getClientSession, type ClientSession } from '@/lib/clientAuth'
import { buildClientChatContext } from '@/lib/clientChatContext'
import { sendAssistanceRequestEmail } from '@/lib/email'
import { clientAvailability, parseClientAvailabilityRequest } from '@/lib/clientAvailability'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── System prompt ────────────────────────────────────────────────────────────
// Conversational: quoting and hold placement are the quote form's (POST
// /api/client/quote and POST /api/client/hold-requests). The AI answers
// questions, checks availability with the quote form's own rules (the
// check_availability tool), explains features, and relays team assistance
// requests (request_assistance). It never states a price.

function buildClientSystemPrompt(companyName: string): string {
  return `You are the Lime Media client portal assistant, speaking with ${companyName}.

CRITICAL — DATA ISOLATION. Read this before anything else:
- You may ONLY discuss ${companyName}'s own account: their own hold requests, and whether their campaign can be booked (check_availability).
- You have ZERO information about any other client's identity — the data you're given never contains another client's name, company, or account details, by design. Do not guess, infer, speculate, or make one up under any circumstance.
- If trucks aren't available, you may say so — but NEVER say or imply who booked them, never guess a company name or industry, and never mention any brand name (including AT&T) even if a pattern seems familiar to you.
- If asked who else uses this platform, which other clients have trucks booked, to compare them to another company, or anything about another client's identity or activity — decline clearly and briefly, and redirect to what you can help with (their own availability and hold requests). Do not soften this into a partial answer.
- Never fabricate a company name, ever, for any reason.

AVAILABILITY: for any question about whether trucks are available in a market on dates, call check_availability with the market, dates and number of trucks. It applies exactly the rules the quote form uses, so give its answer as it is: whether the campaign can be booked online, or its message if not. Never work availability out yourself, and never mention truck numbers, other bookings or where trucks are. If the client hasn't said how many trucks, assume 1 and say so.

WHAT YOU CAN HELP WITH:
- "Tell me about the holds we've placed" / "my hold requests" → list ${companyName}'s own hold requests from the data below.
- Availability questions → check_availability, as above.
- Questions about pricing features (shadow fencing, Smart Directional, Device ID Passback, lift studies) → explain what they are and how they work.
- Market recommendations or campaign planning advice.
- Answering general questions about Lime Media's LED truck advertising.

QUOTING AND HOLDS:
- Pricing quotes and hold placement are now handled directly through the quote form and interactive pricing card above this chat.
- If a client asks for a quote or wants to place a hold, direct them to use the "Get a quote" form at the top of the page — they can enter their market, dates, and truck count, then customize features and place a hold directly from the pricing card.
- You can still discuss pricing concepts, explain features, or help them understand their options conversationally.
- Do NOT attempt to generate prices, state dollar amounts, or submit holds yourself.

REQUESTING TEAM ASSISTANCE:
- request_assistance is your "get a human involved" tool — use it when the client wants to reach the Lime Media team, or has a question you can't answer, once you know what they need.
- The portal shows the client the request's confirmation (or its failure) on its own line, so don't repeat it; just say what you passed on.

Keep every answer short and scannable. Be concise and direct.`
}

// ── Tools ───────────────────────────────────────────────────────────────────

const DATE = { type: 'string', description: 'YYYY-MM-DD' } as const

const CLIENT_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'check_availability',
    description: 'Whether this client can book trucks in one market on these dates online, by the quote form\'s rules (lead time, service area, trucks free). Returns yes or no with a message; never truck numbers or other bookings.',
    input_schema: {
      type: 'object',
      properties: {
        market: { type: 'string', description: 'One US market as "City, ST" or a ZIP.' },
        start_date: DATE,
        end_date: DATE,
        truck_count: { type: 'integer', minimum: 1 },
      },
      required: ['market', 'start_date', 'end_date', 'truck_count'],
    },
  },
  {
    name: 'request_assistance',
    description: 'Send the client\'s question or need to the Lime Media team by email.',
    input_schema: {
      type: 'object',
      properties: {
        details: { type: 'string', description: 'The client\'s question or need, in plain language.' },
        market: { type: 'string', description: 'City, ST, if relevant.' },
        state: { type: 'string', description: '2-letter state, if relevant.' },
        start: DATE,
        end: DATE,
      },
      required: ['details'],
    },
  },
]

/** Tool rounds per message. */
const MAX_TOOL_ROUNDS = 5
/** Availability checks per message: each one loads the whole fleet's timelines and live GPS. */
const MAX_AVAILABILITY_CHECKS = 6

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** The quote form's availability answer, client-safe: no counts, trucks or reasons. */
async function checkClientAvailability(input: Record<string, unknown>, session: ClientSession): Promise<string> {
  const request = parseClientAvailabilityRequest(input)
  if (!request) {
    return JSON.stringify({ error: 'market, start_date and end_date (YYYY-MM-DD) and truck_count (a whole number, at least 1) are required' })
  }
  const { truck_count } = request
  const checked = await clientAvailability(session, request)
  if (checked.refused) {
    const b = checked.refused.body
    // The refusals the quote form shows the client, and nothing else from the body.
    return JSON.stringify({ canBookOnline: false, message: b.message ?? b.error, candidates: b.candidates })
  }
  return JSON.stringify({
    canBookOnline: true,
    market: checked.formalMarket,
    message: `${truck_count} truck${truck_count === 1 ? '' : 's'} can be booked in ${checked.formalMarket} for these dates. The quote form gives the price and places the hold.`,
  })
}

async function executeRequestAssistance(
  input: Record<string, unknown>,
  session: ClientSession
): Promise<{ success: boolean; message: string }> {
  const fields = { details: text(input.details), market: text(input.market), state: text(input.state), start: text(input.start), end: text(input.end) }
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

async function handlePost(req: NextRequest) {
  // The deadline counts from the request, setup included.
  const startedAt = Date.now()
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (session.username !== 'testclient') return NextResponse.json({ error: 'Not available yet' }, { status: 403 })

  const { message, history = [], conversation_id: requestedConversation } = await req.json()
  if (typeof message !== 'string' || !message.trim()) return NextResponse.json({ error: 'Message required' }, { status: 400 })

  // The conversation this message belongs to (lib/conversations.ts).
  const conversationId = await openConversation({ actorType: 'client_user', userId: session.id }, requestedConversation, message)
  await addMessages(conversationId, [{ role: 'user', content: message }])

  let context: string
  try {
    const built = await buildClientChatContext(session)
    context = built.prompt
  } catch (err) {
    console.error('[client/chat] context build failed:', err)
    context = 'Account data temporarily unavailable.'
  }

  const userTurn = `${message}\n\n[ACCOUNT DATA]\n${context}`

  // The portal sends its history with this message already on the end; drop
  // that copy so the model sees it once, with the account data.
  const prior: { role: string; content: string }[] = Array.isArray(history) ? history : []
  const last = prior[prior.length - 1]
  const earlier = last && last.role !== 'assistant' && last.content === message ? prior.slice(0, -1) : prior

  // The conversation sent to the model starts with a user turn.
  const recent = earlier.slice(-10).filter(m => m && typeof m.content === 'string' && m.content.trim())
  while (recent.length && recent[0].role === 'assistant') recent.shift()

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...recent.map(m => ({
      role:    m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: m.content,
    })),
    { role: 'user', content: userTurn },
  ]

  let reply = ''
  // Set inside the tool callbacks; the cast keeps TS from narrowing it to null.
  let actionResult = null as { success: boolean; message: string } | null
  let availabilityChecks = 0
  try {
    for (let round = 0; ; round++) {
      const response = await anthropic.beta.messages.create({
        model:         'claude-opus-5-5',
        // A safety decline is retried server-side on the model Anthropic recommends
        // for its category, instead of returning the refusal (beta).
        betas:         ['server-side-fallback-2026-07-01'],
        fallbacks:     'default',
        max_tokens:    16000,
        thinking:      { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system:        buildClientSystemPrompt(session.companyName),
        tools:         CLIENT_TOOLS,
        messages,
      }, {
        // Every call finishes in time to answer and save before maxDuration
        // (300s), a fallback hop included: the time left, and no SDK retry
        // (a retry, or its wait, could outlast the function).
        timeout: MODEL_DEADLINE_MS - (Date.now() - startedAt),
        maxRetries: 0,
      })
      // The model that served it (a fallback replaces a declined one: lib/claudeReply.ts).
      const said = servedText(response.content)
      const toolUses = servedToolUses(response.content)
      // A refusal or a cut-off tool call (max_tokens) is never run.
      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        reply = said || (response.stop_reason === 'refusal' ? "Sorry, I can't help with that. Ask me about availability or your hold requests." : '')
        break
      }
      if (round >= MAX_TOOL_ROUNDS) {
        // Text beside a tool call is narration ("Let me check…"), not an answer.
        reply = 'Sorry, I could not finish that. Please ask again more narrowly.'
        break
      }
      messages.push({ role: 'assistant', content: response.content })
      // One request to the team per message: claimed before anything runs.
      let assistanceClaimed = actionResult !== null
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = await Promise.all(toolUses.map(async (use): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        const input = (use.input && typeof use.input === 'object' ? use.input : {}) as Record<string, unknown>
        if (use.name === 'check_availability') {
          // Counted before anything runs, like the assistance claim below.
          if (++availabilityChecks > MAX_AVAILABILITY_CHECKS) {
            return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: `At most ${MAX_AVAILABILITY_CHECKS} availability checks per message. Answer with what you have, and ask the client to narrow the rest down.` }
          }
          try {
            return { type: 'tool_result', tool_use_id: use.id, content: await checkClientAvailability(input, session) }
          } catch (err) {
            console.error('[client/chat] availability check failed:', err)
            return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Availability could not be checked right now. Suggest the quote form, or a request to the team.' }
          }
        }
        if (use.name === 'request_assistance' && !assistanceClaimed) {
          assistanceClaimed = true
          let result: { success: boolean; message: string }
          try {
            result = await executeRequestAssistance(input, session)
          } catch (err) {
            console.error('[client/chat] action execution failed:', err)
            result = { success: false, message: 'Failed to submit your request due to a server error.' }
          }
          actionResult = result
          return { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result) }
        }
        return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: use.name === 'request_assistance' ? 'Already sent one request this message.' : `Unknown tool ${use.name}` }
      }))
      messages.push({ role: 'user', content: results })
    }
  } catch (err) {
    console.error('[client/chat] Anthropic call failed:', err)
    // A request already sent to the team is still reported, so it isn't sent twice.
    if (!actionResult) return NextResponse.json({ error: 'Assistant is temporarily unavailable.' }, { status: 502 })
  }

  // An empty reply would go back as an empty history turn, which the API rejects.
  if (!reply && !actionResult) reply = 'Sorry, I could not answer that. Please try asking again.'
  reply = await scrubOtherClientNames(reply, session.id)

  // The conversation keeps the text; the usage log (withUsageLog, below)
  // records that the chat ran and links here by conversation id.
  await addMessages(conversationId, [
    ...(reply ? [{ role: 'assistant' as const, content: reply }] : []),
    ...(actionResult ? [{ role: 'assistant' as const, content: actionResult.message }] : []),
  ])
  return NextResponse.json({ reply, actionResult, conversation_id: conversationId })
}

// A message can chain several Opus calls and availability checks (each a
// fleet load): the same limit as the other routes that load the fleet or call Claude.
export const maxDuration = 300
/** Every model call must finish by this point, leaving time to answer and save. */
const MODEL_DEADLINE_MS = 285_000

// Every run is logged for the Usage page (lib/usageLog.ts).
export const POST = withUsageLog('ai_chat_client', 'client', handlePost)

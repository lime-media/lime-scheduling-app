import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { getClientSession, type ClientSession } from '@/lib/clientAuth'
import { buildClientChatContext, normalizeTruckNumber } from '@/lib/clientChatContext'
import { createHoldRequestForClient, type CreateHoldRequestParams } from '@/lib/holdRequestService'
import { sendAssistanceRequestEmail } from '@/lib/email'
import { computeQuote, VALID_STUDIES, marketSizeTierFromDmaCode, type RateOverrides, type StudyType, type QuoteResult } from '@/lib/pricing'
import { formatMarketState } from '@/lib/format'

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

RIGOR REQUIREMENT — read before stating any count: even though you never display truck numbers to the client, you must still work out the real, specific trucks internally before saying a number out loud. Go through the truck list below, check each one's booked ranges against the exact requested dates and its last known market against the requested city, and only count a truck if it concretely passes both checks. Never state a count you haven't actually derived this way — no rounding up, no "should be a few," no optimistic guesses to sound helpful. Do this full check before your FIRST answer on a given request, not only once you reach the point of actually submitting a hold — if you say a number and then have to walk it back once you look closer, that's the bug: the first answer was wrong because the check was skipped, and telling the client one thing and then correcting yourself is confusing and erodes trust. Get it right once, up front.

NEVER SHOW YOUR WORK — this is as important as the rigor requirement above, not a lesser style note. Do the per-truck checking described above entirely to yourself; the client-facing reply must jump straight to the finished answer. Concretely, your reply must NEVER contain: a truck-by-truck list or checklist (with or without ✅/❌ marks), any truck number, any truck's last-known market or booking history, or narration like "Let me check X" / "Availability check — trucks:" / "Generating your quote now." The client only ever sees the two or three sentences of final result — how many trucks, which market, what it costs — never the reasoning trail that got you there. If you catch yourself about to write "Truck 0044" or "- **Truck" in a reply, stop and delete it; that content belongs in your own internal reasoning only, never in the message the client reads.

WHAT YOU CAN HELP WITH:
- "Tell me about the holds we've placed" / "my hold requests" → list every one of ${companyName}'s own hold requests from the data below: truck number, market/state, dates, status (PENDING/APPROVED/REJECTED), and notes if present.
- Availability questions ("is truck X free on Y", "can I get N trucks in city Z from A to B") → check each truck's booked ranges ONLY against the exact requested start/end date, per the availability rule above. Never mention truck numbers in the reply — the client needs counts and dates, not which specific truck; answer in exactly two short parts, nothing else:
  1. How many trucks have ZERO booked ranges overlapping the requested window, even partially — state the count plainly (e.g. "8 trucks are available for your full date range"). A booking anywhere else on the calendar — before it, after it, a week away, a day away — is irrelevant and must NEVER be mentioned, hinted at, or added as a caveat/aside/"heads up".
     Example: requested window is Sep 1–5. A truck's nearest booking is Sep 21–27. That truck counts as fully available for Sep 1–5, full stop. Do not mention the Sep 21–27 booking anywhere in the answer.
  2. Only if part 1's count is thin or zero, also mention how many trucks are available for PART of the window (booked range overlaps only partially) and when the earliest of those opens up (e.g. "a couple more open up starting Aug 15").
  Do NOT explain a truck's full booking history, when its last booking ended, what other cities it's booked in, or walk through your reasoning for each truck — the client only needs to know what's open, not the calendar detail behind it. If NOTHING is available at all, say so plainly and stop; don't pad the answer with unavailable trucks and their booking details.
- Multi-truck requests for a specific market ("can I get 3 trucks in Houston", "I need 5 trucks in Dallas from A to B") → first identify every truck available for the requested dates (per the availability rule above) whose last known market is that city. If that count meets or exceeds what was asked for, answer normally per the rule above (counts only, no truck numbers).
  If FEWER trucks are available in that exact market than requested, this is still a yes — never treat it as something you can't fulfill or as a reason to involve the team. State how many are available right in that market (a count only, never truck numbers — the client doesn't need those), then note that the rest will come from a nearby market, or possibly out-of-state, so pricing will vary accordingly for those, and point them to the quote for the actual numbers. For example: "Yes — 3 of the 5 trucks you asked for are available right in Dallas. The other 2 will need to be moved in from another market, or possibly out of state, so the cost will vary for those. The quote below will break that down." One short paragraph.
  For the remaining trucks (the ones NOT in the requested market), do not elaborate — no "there are plenty of trucks available in X and surrounding states," no naming specific trucks or their markets, no quantities. A brief "yes, there are trucks available for those" is enough.
  Hold requests can still be submitted for all of them, in-market and the rest, the normal way once confirmed (see TAKING ACTION — submitting hold requests below) — truck numbers are picked internally when submitting, never something you need to show the client first.
- Ground every answer in the data provided below. If something isn't in the data, say you don't have that information rather than guessing.
- If asked how to contact/reach Lime Media, or to ask the team something you can't answer yourself from the data — never send them off to go find contact info on their own (no "check your portal," no "contact your account rep"). Tell them to just say what they need and you'll pass it straight to the team, and they'll hear back by email within 12-24 hours. See TAKING ACTION — requesting team assistance below for the mechanics.
- Keep every answer short and scannable. No walls of text, no restating the same fact multiple ways.
- Be concise and direct. Plain sentences or short bullet lists — no markdown tables needed.
- Never narrate your own message-parsing to the client (e.g. "I see both a free-text request and a structured request," "let me work through this once," "I notice you've included..."). None of that is useful to them — just work out what they're asking for internally and answer it. If a message genuinely looks contradictory or ambiguous after you've actually read it, ask a short, plain clarifying question about the substance (e.g. "Did you mean 2 trucks or 3?") — never describe the format their message arrived in.

MANDATORY WORKFLOW — Availability → Quote → Hold:
A hold is a commitment to a specific price, feature set, and set of trucks. This workflow is strictly ordered — each step depends on the previous one:
  Step 1: AVAILABILITY — determine how many trucks are available in the requested market for the requested dates (per the availability and rigor rules above). You must complete this before quoting. This step is entirely internal — see NEVER SHOW YOUR WORK above; nothing about individual trucks belongs in the reply.
  Step 2: QUOTE — generate a price quote for the ACTUAL available count (not a hypothetical number). The quote locks the rate, tier, and features. You must have a quote in this conversation before placing a hold.
  Step 3: HOLD — submit hold requests at the quoted price and tier. The hold carries the pricing snapshot from the quote.
Never skip steps. If a client asks to "book" or "hold" without having first checked availability and gotten a quote in this conversation, walk them through the steps: check availability first, then quote, then hold.

TAKING ACTION — generating a price quote (Step 2):
- ${companyName} can ask for pricing — you have a real, code-computed quote engine behind you. NEVER estimate, guess, or state a dollar figure yourself; every number in your reply must come from the computed result the system appends after you request it. If you don't have enough information yet, ask for it.
- PREREQUISITE: You must have already checked availability for these dates/market in this conversation. The truck count in the quote must match what's actually available (or fewer if the client wants fewer).
- To request a quote you need: number of trucks, the campaign market, and the exact start/end dates. Optionally, only if the client actually mentions them: the Smart Directional add-on, the Device ID Passback add-on, and/or which lift study types (web_lift, foot_traffic, sales_lift, brand_lift).
- No confirmation step needed — a quote is informational, not a booking.
- Once you have the details, append this block at the very end of your reply:
[ACTION: GET_QUOTE]
truck_count: <int>
market: <City, ST — the campaign market being quoted>
start: <YYYY-MM-DD>
end: <YYYY-MM-DD>
smart_directional: <yes/no — omit this line entirely if not mentioned>
device_id: <yes/no — omit this line entirely if not mentioned>
studies: <comma-separated from web_lift, foot_traffic, sales_lift, brand_lift — omit this line entirely if none mentioned>
[/ACTION]
  - Always include the market line — the system uses it to determine the correct impression tier.
  - Only include optional lines the client actually gave an answer for.
  - No markdown inside the block. Plain text only.
- The system's quote is computed by the pricing engine — present it as-is without adding disclaimers or caveats.

TAKING ACTION — submitting hold requests (Step 3):
- You can submit hold requests on ${companyName}'s behalf when asked and confirmed. You can only ever create a REQUEST (status PENDING) — never a confirmed booking. Every request still goes through the same Lime Media team review; nothing you submit is ever auto-approved. Holds expire after 72 hours if not acted on by the team.
- PREREQUISITE: You must have a quote in THIS conversation for these trucks/dates/market before submitting a hold. The hold locks in the quoted price. If the client hasn't gotten a quote yet, generate one first.
- Only offer to submit for trucks you've already shown as available AND quoted in this conversation, for the exact dates being discussed.
- Two ways a hold gets confirmed — do not ask for confirmation twice:
  1. FREE-TEXT: the client typed a hold request in plain language. After availability + quote, state exactly what you're about to submit — how many trucks, market/state, start and end dates, the pricing tier they chose, and the quoted total — and ask them to confirm. Only submit after a clear reply ("yes", "go ahead", "submit those", "do it"); a vague reply is not confirmation.
  2. STRUCTURED (intent "hold" — see STRUCTURED REQUESTS below): the client already picked the tier and hit Send on a form pre-filled with the market/dates/trucks from their own quote request. That submission IS the confirmation, full stop — never restate the details and ask "can you confirm?" a second time, and never wait for a follow-up reply. As long as a matching quote already exists in this conversation, submit immediately in the same turn: check availability if not already fresh, then go straight to the PLACE_HOLD_REQUESTS block below in that same reply. It's fine to briefly acknowledge what you submitted afterward — just don't gate it behind another round-trip.
- Once ready to submit (via either path above), append this block at the very end of your reply, one line per truck:
[ACTION: PLACE_HOLD_REQUESTS]
truck: <truck_number> | market: <City, ST> | state: <2-letter state> | start: <YYYY-MM-DD> | end: <YYYY-MM-DD> | tier: <Good|Better|Best> | notes: <optional context>
[/ACTION]
  - The "tier" field is REQUIRED — it must match the pricing tier the client chose from the quote.
  - The "truck_number" MUST be copied character-for-character from the TRUCK AVAILABILITY list below, including any leading zeros (e.g. "0044", not "44"). Never reformat, shorten, or reinterpret it as a plain number — a changed truck number silently fails the submission.
  - Never emit this block without confirmation via one of the two paths above.
  - Only include the trucks the client actually confirmed — never pad the list.
  - No markdown inside the block. Plain text only.

STRUCTURED REQUESTS:
- The client's message may include a [STRUCTURED REQUEST] block with pre-parsed fields (market, start_date, end_date, truck_count, tier_preference). When present, use these values exactly as given — they were entered via form fields and are authoritative. Even with structured fields, you must still follow the Availability → Quote → Hold workflow. If the intent is "quote", check availability first (if not already done), then generate a GET_QUOTE action block. If the intent is "hold", this submission is itself the client's explicit confirmation (see TAKING ACTION — submitting hold requests, path 2) — as long as a quote already exists in this conversation for these trucks/dates/market, submit the hold in this same reply rather than asking the client to confirm again.

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

const ACTION_RE = /\[ACTION:\s*(PLACE_HOLD_REQUESTS|REQUEST_ASSISTANCE|GET_QUOTE)\]([\s\S]*?)\[\/ACTION\]/
const MAX_HOLD_REQUESTS_PER_TURN = 20

function stripActionBlock(text: string): string {
  return text.replace(ACTION_RE, '').trim()
}

type ParsedHoldLine = CreateHoldRequestParams & { tier?: string }

function parseHoldRequestLines(body: string): ParsedHoldLine[] {
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
        notes:        fields.notes  ?? undefined,
        tier:         fields.tier   ?? undefined,
      }
    })
    .filter((p) => p.truck_number && p.start_date && p.end_date)
}

async function executePlaceHoldRequests(
  actionBody: string,
  session: ClientSession,
  knownLocationTrucks: Map<string, string>,
): Promise<{ success: boolean; message: string }> {
  const items = parseHoldRequestLines(actionBody)
  if (items.length === 0) {
    return { success: false, message: 'No valid hold request details found — nothing was submitted.' }
  }
  if (items.length > MAX_HOLD_REQUESTS_PER_TURN) {
    return { success: false, message: `That's ${items.length} trucks at once — please ask for ${MAX_HOLD_REQUESTS_PER_TURN} or fewer per request.` }
  }

  // Generate a campaign group ID to link all trucks in this hold together
  const campaignGroupId = `cg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  // Resolve pricing for the tier the AI selected. This RECOMPUTES the quote from this action's
  // own market/dates/truck-count rather than reusing a "last quote" captured earlier in the same
  // request — GET_QUOTE and PLACE_HOLD_REQUESTS are never the same turn in practice (Quote and
  // Hold are always separate steps for the client), so a same-turn-only "last quote" is never
  // actually populated when a hold is placed. This was a real bug: quoted_total/daily_rate/
  // features were silently null on every AI-placed hold ever created, regardless of how today's
  // various frontend/prompt fixes changed the surrounding flow — nothing before this recomputed
  // pricing at hold time at all. Recomputing is deterministic (same market/dates/truck count
  // always reproduces the exact numbers the client already saw) and needs no cross-turn state.
  // Known gap: this doesn't know about Smart Directional/Device ID/lift-study add-ons a client
  // asked for via free text during the original Quote step (today's structured Quote box has no
  // such fields, so this only affects the older typed-Ask-mode quote path) — those would be
  // included in the total the client originally saw but not in this recomputed snapshot.
  const tierFromAction = items[0]?.tier ?? null
  const pricingTier = tierFromAction?.charAt(0).toUpperCase() + (tierFromAction?.slice(1).toLowerCase() ?? '')
  let quotedTotal: number | null = null
  let features: string | null = null

  let lastQuote: QuoteResult | null = null
  const first = items[0]
  if (first?.market && first.start_date && first.end_date) {
    const startDate = new Date(first.start_date + 'T00:00:00Z')
    const endDate   = new Date(first.end_date + 'T00:00:00Z')
    const days = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1
    if (Number.isFinite(days) && days >= 1) {
      try {
        const marketSizeTierId = await resolveMarketSizeTierId(first.market)
        const rateOverrides = await resolveRateOverrides(session)
        lastQuote = computeQuote({ truckCount: items.length, days, marketSizeTierId, rateOverrides })
      } catch (err) {
        console.error('[client/chat] failed to recompute quote for hold pricing snapshot:', err)
      }
    }
  }

  if (lastQuote && pricingTier) {
    const tierKey = pricingTier.toLowerCase() as 'good' | 'better' | 'best'
    if (tierKey in lastQuote) {
      quotedTotal = lastQuote[tierKey].total
    }
    // Full dollar-line breakdown for the chosen tier, not just which add-ons were included —
    // this is what actually lets a client (and staff, on the internal review page) see how the
    // total was derived: base media, shadow fencing, smart directional, device ID, lift studies,
    // each as an actual amount rather than a boolean. Shadow fencing/smart directional/device ID
    // all live on the `better` tier object regardless of which tier was chosen, since Better and
    // Best both build on top of it (Best = betterTotal + studies).
    features = JSON.stringify({
      dailyRate:          lastQuote.dailyRate,
      hourSurcharge:       lastQuote.hourSurcharge,
      truckDays:          lastQuote.input.truckDays,
      baseMedia:          lastQuote.good.baseMedia,
      shadowFencing:          tierKey !== 'good' ? lastQuote.better.shadowFencing : 0,
      shadowFencingFloored:   tierKey !== 'good' ? lastQuote.better.shadowFencingFloored : false,
      smartDirectionalIncluded: tierKey !== 'good' && lastQuote.better.smartDirectionalIncluded,
      smartDirectional:      tierKey !== 'good' ? lastQuote.better.smartDirectional : 0,
      deviceIdIncluded:      tierKey !== 'good' && lastQuote.better.deviceIdIncluded,
      deviceId:              tierKey !== 'good' ? lastQuote.better.deviceId : 0,
      studies:               tierKey === 'best' ? lastQuote.best.studies : [],
      studyCost:             lastQuote.best.studyCost,
      studiesTotal:          tierKey === 'best' ? lastQuote.best.studiesTotal : 0,
    })
  }

  const created: string[] = []
  const failed:  string[] = []
  for (const item of items) {
    // Match on the raw truck number as written, falling back to a zero-stripped comparison —
    // the model sometimes drops leading zeros ("44" instead of "0044") when copying a truck
    // number into the compact action-block format. Either way, resolve to the CANONICAL
    // (DB-format) truck number so what actually gets persisted is never malformed.
    const canonicalTruckNumber =
      knownLocationTrucks.get(item.truck_number) ?? knownLocationTrucks.get(normalizeTruckNumber(item.truck_number))
    if (!canonicalTruckNumber) {
      console.error('[client/chat] rejected hold request for truck with no known location:', item.truck_number)
      failed.push(item.truck_number)
      continue
    }
    try {
      await createHoldRequestForClient(session, {
        ...item,
        truck_number:      canonicalTruckNumber,
        pricing_tier:      pricingTier || null,
        quoted_total:      quotedTotal,
        daily_rate:        lastQuote?.dailyRate ?? null,
        features,
        truck_count:       items.length,
        campaign_group_id: campaignGroupId,
      })
      created.push(item.truck_number)
    } catch (err) {
      console.error('[client/chat] failed to create hold request:', err)
      failed.push(item.truck_number)
    }
  }

  if (created.length === 0) {
    return { success: false, message: "Sorry, I couldn't submit that — please try again or use the Schedule Grid directly." }
  }

  const tierLabel = pricingTier || 'standard'
  const priceLabel = quotedTotal ? ` at ${fmtMoney(quotedTotal)} (${tierLabel} tier)` : ''
  // Market/dates only — never the truck number itself. This message is shown directly to the
  // client (see actionResult in the frontend), and truck numbers are internal-only everywhere
  // else in this codebase (the system prompt's rigor requirement, the availability-answer rule,
  // etc.) — this "submitted" summary was the one place that policy wasn't enforced in code.
  const submittedDetails = items
    .filter((item) => created.includes(item.truck_number))
    .map((item) => `${formatMarketState(item.market, item.state)} (${item.start_date} → ${item.end_date})`)
    .join('; ')

  let message = `Submitted ${created.length} hold request${created.length > 1 ? 's' : ''}${priceLabel} for review. Holds expire in 72 hours. The Lime Media team will review ${created.length > 1 ? 'them' : 'it'} from here.`
  if (submittedDetails) message += ` Details: ${submittedDetails}.`
  if (failed.length > 0) {
    message += ` (${failed.length} couldn't be submitted — please try again.)`
  }
  return { success: true, message }
}

// Shared "key: value" per-line parser — used by both REQUEST_ASSISTANCE and GET_QUOTE, whose
// action bodies are both flat field lists (unlike PLACE_HOLD_REQUESTS, which is one truck per
// pipe-delimited line).
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

// ── Quote generation ─────────────────────────────────────────────────────────
// Wires the client chat up to the same self-service quoting engine (lib/pricing) that powers
// POST /api/v1/internal/quote — but calls computeQuote() directly rather than round-tripping
// through that HTTP endpoint, since this is already server-side code in the same app. All dollar
// figures are computed here in code and appended to the reply verbatim; the model never states
// its own numbers (see the system prompt's GET_QUOTE section) — pricing is exactly the kind of
// thing that must never be left to the model to "remember" or estimate.
//
// Deliberately NOT wired here: transport/logistics pricing (priceTransport in lib/pricing) — that
// requires resolving the campaign city to a lat/lng and finding the nearest AcceptedMarket, and
// there's no geocoding integration in this codebase yet. The reply below says so plainly rather
// than silently omitting it.

function fmtMoney(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

/** Structured quote data for rendering as pricing cards on the frontend. */
type QuoteCardData = {
  truckCount: number
  days: number
  truckDays: number
  dailyRate: number
  marketSizeTier: { id: number; label: string }
  good:   { total: number; description: string }
  better: { total: number; description: string; includes: string[] }
  best:   { total: number; description: string; includes: string[]; available: boolean; reason?: string }
  pricingBasis: string
}

function buildQuoteCardData(quote: QuoteResult): QuoteCardData {
  const betterIncludes = [
    'Shadow fencing',
    quote.better.smartDirectionalIncluded ? 'Smart Directional' : null,
    quote.better.deviceIdIncluded ? 'Device ID Passback' : null,
  ].filter(Boolean) as string[]

  const bestIncludes = [...betterIncludes]
  if (quote.best.studies.length > 0) {
    bestIncludes.push(...quote.best.studies.map(s => s.replace(/_/g, ' ') + ' study'))
  }

  return {
    truckCount:     quote.input.truckCount,
    days:           quote.input.days,
    truckDays:      quote.input.truckDays,
    dailyRate:      quote.dailyRate,
    marketSizeTier: { id: quote.input.marketSizeTier.id, label: quote.input.marketSizeTier.label },
    good: {
      total:       quote.good.total,
      description: 'Base media only',
    },
    better: {
      total:       quote.better.total,
      description: 'Base media + digital amplification',
      includes:    betterIncludes,
    },
    best: {
      total:       quote.best.total,
      description: 'Full measurement suite',
      includes:    bestIncludes,
      available:   quote.best.reachOk,
      reason:      !quote.best.reachOk ? `Projected reach (${Math.round(quote.best.estimatedImpressions).toLocaleString('en-US')} impressions) is below the ${(1_200_000).toLocaleString('en-US')} minimum for lift studies.` : undefined,
    },
    pricingBasis: quote.pricingBasis,
  }
}

function formatQuoteMessage(quote: QuoteResult): string {
  const { truckCount, days, truckDays } = quote.input
  const lines: string[] = []

  lines.push(
    `Quote for ${truckCount} truck${truckCount === 1 ? '' : 's'} over ` +
    `${days} day${days === 1 ? '' : 's'} (${truckDays} truck-day${truckDays === 1 ? '' : 's'}):`
  )
  lines.push('')
  lines.push(`Good — ${fmtMoney(quote.good.total)}: base media only.`)

  const betterAddOns = [
    'shadow fencing',
    quote.better.smartDirectionalIncluded ? 'Smart Directional' : null,
    quote.better.deviceIdIncluded ? 'Device ID Passback' : null,
  ].filter(Boolean).join(', ')
  lines.push(`Better — ${fmtMoney(quote.better.total)}: adds ${betterAddOns}.`)

  if (quote.best.studies.length > 0) {
    const studyWord = quote.best.studies.length === 1 ? 'study' : 'studies'
    lines.push(`Best — ${fmtMoney(quote.best.total)}: adds a ${quote.best.studies.join(', ')} lift ${studyWord}.`)
  } else if (!quote.best.reachOk) {
    lines.push(`Best tier — not available for this campaign size (projected reach below lift-study minimum).`)
  }

  if (quote.pricingBasis.startsWith('agreement')) {
    lines.push('')
    lines.push('Pricing uses your negotiated rate.')
  }

  return lines.join('\n')
}

// Derive market size tier from a campaign market string by matching against accepted markets.
// Falls back to tier 3 (mid/large) if no match found — safe default that doesn't over-promise
// on lift-study eligibility. Shared by executeGetQuote and executePlaceHoldRequests (the latter
// recomputes a quote from scratch since it can't rely on one already existing this turn — see
// the comment there).
async function resolveMarketSizeTierId(market: string): Promise<number> {
  if (!market) return 3
  try {
    const acceptedMarkets = await prisma.acceptedMarket.findMany({
      where: { is_active: true },
      select: { dma_code: true, dma_name: true },
    })
    const marketLower = market.toLowerCase()
    // Match on city name — the DMA name is "City, ST" format, same as the market field
    const matched = acceptedMarkets.find((am) => {
      const dmaCity = am.dma_name.split(',')[0].trim().toLowerCase()
      const reqCity = marketLower.split(',')[0].trim()
      return dmaCity === reqCity || marketLower.includes(dmaCity) || dmaCity.includes(reqCity)
    })
    return matched ? marketSizeTierFromDmaCode(matched.dma_code) : 3
  } catch (err) {
    console.error('[client/chat] market size tier lookup failed, using default tier 3:', err)
    return 3
  }
}

// Standard rate card unless this client has an active negotiated RateAgreement — same lookup
// POST /api/v1/internal/quote does, keyed off the client_user's optional partner_id link.
async function resolveRateOverrides(session: ClientSession): Promise<RateOverrides | null> {
  if (!session.partnerId) return null
  try {
    const now = new Date()
    const agreement = await prisma.rateAgreement.findFirst({
      where: {
        partner_id:      session.partnerId,
        effective_date:  { lte: now },
        expiration_date: { gte: now },
      },
      orderBy: { created_at: 'desc' },
    })
    return agreement ? (JSON.parse(agreement.rate_overrides) as RateOverrides) : null
  } catch (err) {
    // Falls back to standard pricing — a rate-agreement lookup failure must never block a quote.
    console.error('[client/chat] rate agreement lookup failed, using standard rate card:', err)
    return null
  }
}

async function executeGetQuote(
  actionBody: string,
  session: ClientSession
): Promise<{ success: boolean; message: string; quoteCard?: QuoteCardData }> {
  const fields = parseKeyValueLines(actionBody)

  const truckCount = parseInt(fields.truck_count ?? '', 10)
  const { start, end } = fields
  if (!truckCount || truckCount < 1 || !start || !end) {
    return { success: false, message: "Sorry, I didn't have enough information to generate a quote — I need a truck count and campaign dates." }
  }

  const startDate = new Date(start + 'T00:00:00Z')
  const endDate   = new Date(end + 'T00:00:00Z')
  const days = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1
  if (!Number.isFinite(days) || days < 1) {
    return { success: false, message: "Sorry, those dates didn't work out to a valid campaign length — please try again." }
  }

  const includeSmartDirectional = (fields.smart_directional ?? '').toLowerCase().startsWith('y')
  const includeDeviceId         = (fields.device_id ?? '').toLowerCase().startsWith('y')
  const studies = (fields.studies ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is StudyType => (VALID_STUDIES as readonly string[]).includes(s))

  const marketSizeTierId = await resolveMarketSizeTierId(fields.market ?? '')
  const rateOverrides = await resolveRateOverrides(session)

  let quote: QuoteResult
  try {
    quote = computeQuote({
      truckCount,
      days,
      marketSizeTierId,
      includeSmartDirectional,
      includeDeviceId,
      studies,
      rateOverrides,
    })
  } catch (err) {
    console.error('[client/chat] quote computation failed:', err)
    return { success: false, message: "Sorry, I couldn't generate a quote for that — please try again or ask the team directly." }
  }

  return { success: true, message: formatQuoteMessage(quote), quoteCard: buildQuoteCardData(quote) }
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

  for (const needle of needles) {
    // Word-boundary match to avoid false positives from company names that are common English
    // substrings (e.g. a company named "Quest" matching "hold requests"). The \b anchors
    // prevent partial-word collisions while still catching the name used standalone.
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
  // Staged rollout — the client AI assistant is limited to the testclient account in
  // production until it's validated more broadly. Remove this gate to open it up.
  if (session.username !== 'testclient') return NextResponse.json({ error: 'Not available yet' }, { status: 403 })

  const { message, history = [], structured } = await req.json()
  // A structured Quote/Hold submission (fields filled, nothing typed) sends an empty message —
  // that's fine as long as the structured block below carries the actual request.
  const hasStructured = Boolean(structured && (structured.market || structured.start_date || structured.truck_count))
  if (!message && !hasStructured) return NextResponse.json({ error: 'Message required' }, { status: 400 })

  let context: string
  let knownLocationTrucks: Map<string, string> = new Map()
  try {
    const built = await buildClientChatContext(session)
    context = built.prompt
    knownLocationTrucks = built.knownLocationTrucks
  } catch (err) {
    console.error('[client/chat] context build failed:', err)
    context = 'Account data temporarily unavailable.'
  }

  // When the frontend sends structured parameters (from Quote/Hold mode), inject them as a
  // clear instruction block so the AI uses the pre-parsed values directly instead of extracting
  // them from the free-text message. This eliminates count/date hallucination. When there's no
  // typed message alongside it (the common case — fields filled, nothing typed), this block is
  // the ENTIRE request; don't pair it with a synthetic sentence like "Please quote this
  // request," which reads to the model as a second, separate free-text ask for the same thing.
  let structuredBlock = ''
  if (hasStructured) {
    const parts: string[] = [`[STRUCTURED REQUEST — use these values exactly. This is the client's actual request, submitted via form fields, not a second request alongside any text above.]`]
    parts.push(`intent: ${structured.intent ?? 'ask'}`)
    if (structured.market)          parts.push(`market: ${structured.market}`)
    if (structured.start_date)      parts.push(`start_date: ${structured.start_date}`)
    if (structured.end_date)        parts.push(`end_date: ${structured.end_date}`)
    if (structured.truck_count)     parts.push(`truck_count: ${structured.truck_count}`)
    if (structured.tier_preference) parts.push(`tier_preference: ${structured.tier_preference}`)
    parts.push(`[/STRUCTURED REQUEST]`)
    structuredBlock = parts.join('\n')
  }

  const userTurn = [message || null, structuredBlock || null, `[ACCOUNT DATA]\n${context}`]
    .filter(Boolean)
    .join('\n\n')

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

  // ── Parse & execute any action block ───────────────────────────────────────
  // Done on the RAW reply, before scrubbing — the block is structured data (truck/market/date
  // fields), not prose, and stripping it first keeps the scrub focused purely on the natural-
  // language answer.
  const actionMatch = reply.match(ACTION_RE)
  reply = actionMatch ? stripActionBlock(reply) : reply
  reply = await scrubOtherClientNames(reply, session.id)

  let actionResult: { success: boolean; message: string; quoteCard?: QuoteCardData } | null = null
  if (actionMatch) {
    const [, actionType, actionBody] = actionMatch
    try {
      if (actionType === 'REQUEST_ASSISTANCE') {
        actionResult = await executeRequestAssistance(actionBody, session)
      } else if (actionType === 'GET_QUOTE') {
        actionResult = await executeGetQuote(actionBody, session)
      } else {
        // PLACE_HOLD_REQUESTS recomputes its own pricing snapshot from this action's fields —
        // see the comment in executePlaceHoldRequests for why it can't rely on a quote captured
        // earlier in this same request.
        actionResult = await executePlaceHoldRequests(actionBody, session, knownLocationTrucks)
      }
    } catch (err) {
      console.error('[client/chat] action execution failed:', err)
      actionResult = { success: false, message: 'Failed to submit your request due to a server error.' }
    }
  }

  // Flat, client-wise log of both sides of the exchange, for simple cross-client reporting.
  // Written here (not at question time) so question and answer land in the same row.
  // Awaited (not fire-and-forget) — this is a serverless function, and an unawaited write
  // issued right before returning can get its execution environment torn down before the
  // request to the DB ever completes, silently dropping the row with no error logged. A
  // logging failure still must never surface to the client, so it's caught, not re-thrown.
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

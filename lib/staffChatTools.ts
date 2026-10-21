/**
 * The staff AI chat's tools. Each one calls the same code the app's own pages
 * do, so the chat can't quote or book on different logic:
 *
 * - check_availability: the availability engine (checkAvailability), with the
 *   staff quote's market rules (resolveQuoteMarket).
 * - get_quote: the staff quote (lib/staffQuote.ts), as the /quote page prices it.
 * - find_account / find_contacts: the quote page's Salesforce pickers.
 * - place_hold: the staff booking (lib/staffBooking.ts), as the /quote page's
 *   Reserve: same truck choice, price check, hold expiry and opportunity.
 *
 * A booking needs the rep to have seen and confirmed the quote: get_quote
 * returns a quote ref, an HMAC of the inputs and total, and place_hold books
 * only when that ref is in a reply the rep was shown in an earlier turn. A
 * booking with other inputs or another total has another ref, so the chat
 * can't book something different from what the rep confirmed.
 *
 * Releasing a hold stays in app/api/chat/route.ts.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { checkAvailability } from '@/lib/availabilityEngine'
import { resolveDefaultRateOverrides } from '@/lib/pricing/resolvers'
import { VALID_STUDIES } from '@/lib/pricing'
import { MAX_HOLD_DAYS } from '@/lib/holdExpiry'
import { OPEN_STAGES } from '@/lib/sfdcStages'
import { isSfdcConfigured } from '@/lib/salesforceClient'
import { isAccountId, searchAccounts, searchContacts } from '@/lib/sfdcSearch'
import { resolveQuoteMarket, staffQuote, type StaffQuoteInput } from '@/lib/staffQuote'
import { placeStaffBooking } from '@/lib/staffBooking'
import { recordToolRun, type Actor } from '@/lib/usageLog'
import { quoteRef } from '@/lib/quoteRef'

const DATE = { type: 'string', description: 'YYYY-MM-DD' } as const

/** The inputs that set a quote's price and what it books, shared by get_quote and place_hold. */
const QUOTE_PROPERTIES = {
  market: { type: 'string', description: 'One US market as "City, ST" (or a ZIP). For place_hold, the market exactly as get_quote returned it.' },
  start_date: DATE,
  end_date: DATE,
  truck_count: { type: 'integer', minimum: 1 },
  shadow_fencing: { type: 'boolean', description: 'Default true.' },
  smart_directional: { type: 'boolean', description: 'Default false.' },
  device_id: { type: 'boolean', description: 'Default false.' },
  studies: { type: 'array', items: { type: 'string', enum: [...VALID_STUDIES] }, description: 'Lift studies. Only priced when projected reach meets the minimum.' },
  days_per_week: { type: 'integer', enum: [5, 6, 7], description: 'Omit unless the rep says; the engine decides from the dates.' },
  operating_hours: { type: 'number', description: 'Hours per day. Default 8.' },
  sfdc_account_id: { type: 'string', description: 'Salesforce Account id from find_account. Sets agreement pricing and Brand Direct.' },
  brand_markup_pct: { type: 'number', description: 'Brand Direct markup %, only if the rep gives one. Applies only to Brand Direct accounts.' },
} as const

const QUOTE_REQUIRED = ['market', 'start_date', 'end_date', 'truck_count']

export const CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'check_availability',
    description: 'Which trucks can take a campaign in one market on these dates, nearest first, with distance from where each truck will be released, and the trucks that cannot (with why and the dates they could do). Uses the standard service area; an account\'s rate agreement can change it, so get_quote is the final word. Use this for every availability or "nearest truck" question; never work distances out yourself.',
    input_schema: {
      type: 'object',
      properties: { market: QUOTE_PROPERTIES.market, start_date: DATE, end_date: DATE, truck_count: QUOTE_PROPERTIES.truck_count },
      required: QUOTE_REQUIRED,
    },
  },
  {
    name: 'get_quote',
    description: 'Price one market exactly as the internal Quote page does: trucks picked, media, features, transport, total. Returns quote_ref when the trucks are there to book it. Include sfdc_account_id when the rep may book, so agreement and Brand Direct pricing apply.',
    input_schema: { type: 'object', properties: QUOTE_PROPERTIES, required: QUOTE_REQUIRED },
  },
  {
    name: 'find_account',
    description: 'Search Salesforce Accounts by name. Returns id, name and client type (Agency or Brand Direct).',
    input_schema: { type: 'object', properties: { query: { type: 'string', minLength: 2 } }, required: ['query'] },
  },
  {
    name: 'find_contacts',
    description: 'Contacts on a Salesforce Account, to pick the opportunity\'s primary contact. query filters by name or email.',
    input_schema: {
      type: 'object',
      properties: { account_id: { type: 'string' }, query: { type: 'string' } },
      required: ['account_id'],
    },
  },
  {
    name: 'place_hold',
    description: 'Reserve the trucks for a quote the rep has seen and confirmed, and create the Salesforce opportunity, exactly as the Quote page\'s Reserve does. Pass the same quote inputs as the get_quote call, its quote_ref and its grandTotal. Refused unless the quote ref was in an earlier reply and the inputs and total match it.',
    input_schema: {
      type: 'object',
      properties: {
        ...QUOTE_PROPERTIES,
        quote_ref: { type: 'string', description: 'The quote_ref get_quote returned.' },
        expected_total: { type: 'number', description: 'The quote\'s grandTotal.' },
        sfdc_account_name: { type: 'string' },
        primary_contact_id: { type: 'string', description: 'Salesforce Contact id from find_contacts.' },
        brand: { type: 'string', description: 'The brand being advertised, if the rep gave one.' },
        hold_days: { type: 'integer', minimum: 1, maximum: MAX_HOLD_DAYS, description: 'Days to hold. Default 3; it never runs past 2 days before the start.' },
        stage: { type: 'string', enum: OPEN_STAGES.map(s => s.value), description: 'Opportunity stage. Default WARM.' },
      },
      required: [...QUOTE_REQUIRED, 'quote_ref', 'expected_total', 'sfdc_account_id', 'sfdc_account_name', 'primary_contact_id'],
    },
  },
  {
    name: 'release_hold',
    description: 'Release (delete) one hold by its id from the HOLDS list. Only after the rep confirmed this exact hold. Committed (Closed Won) and AT&T soft holds are refused.',
    input_schema: { type: 'object', properties: { hold_id: { type: 'string' } }, required: ['hold_id'] },
  },
]

export type ChatToolContext = {
  actor: Actor & { email?: string | null }
  /** Everything the assistant said to the rep in earlier turns. */
  shownText: string
  /** A booking already ran this turn: one booking per message. */
  booked: boolean
}

export type ChatToolOutcome = {
  content: string
  isError?: boolean
  /** A change the rep is shown as its own line (a booking). */
  action?: { success: boolean; message: string }
  /** A quote the rep can book, to be shown with its ref. */
  quote?: { ref: string; summary: string }
}

// ── Input checks: the model's input is checked like any request body ─────────

type Bag = Record<string, unknown>
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const isBool = (v: unknown) => v === undefined || typeof v === 'boolean'
const isNum = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v))

/** The quote inputs, type-checked; a string saying what's wrong otherwise. */
function quoteInput(i: Bag): StaffQuoteInput | string {
  if (!isStr(i.market)) return 'market is required'
  if (!isDate(i.start_date) || !isDate(i.end_date)) return 'start_date and end_date must be YYYY-MM-DD'
  if (typeof i.truck_count !== 'number' || !Number.isInteger(i.truck_count) || i.truck_count < 1) return 'truck_count must be a whole number of at least 1'
  if (!isBool(i.shadow_fencing) || !isBool(i.smart_directional) || !isBool(i.device_id)) return 'shadow_fencing, smart_directional and device_id are true or false'
  if (i.studies !== undefined && !(Array.isArray(i.studies) && i.studies.every(s => typeof s === 'string'))) return 'studies is a list of study names'
  if (i.days_per_week !== undefined && ![5, 6, 7].includes(i.days_per_week as number)) return 'days_per_week is 5, 6 or 7'
  if (!isNum(i.operating_hours) || !isNum(i.brand_markup_pct)) return 'operating_hours and brand_markup_pct are numbers'
  if (i.sfdc_account_id !== undefined && !(typeof i.sfdc_account_id === 'string' && isAccountId(i.sfdc_account_id))) return 'sfdc_account_id must be a Salesforce Account id from find_account'
  return {
    market: i.market.trim(), start_date: i.start_date, end_date: i.end_date, truck_count: i.truck_count,
    shadow_fencing: i.shadow_fencing as boolean | undefined, smart_directional: i.smart_directional as boolean | undefined,
    device_id: i.device_id as boolean | undefined, studies: i.studies as string[] | undefined,
    days_per_week: i.days_per_week as 5 | 6 | 7 | undefined, operating_hours: i.operating_hours as number | undefined,
    sfdc_account_id: i.sfdc_account_id as string | undefined, brand_markup_pct: i.brand_markup_pct as number | undefined,
  }
}

const json = (v: unknown) => JSON.stringify(v)
const fail = (message: string): ChatToolOutcome => ({ content: json({ error: message }), isError: true })
const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

// ── The tools ───────────────────────────────────────────────────────────────

export async function runChatTool(name: string, input: unknown, ctx: ChatToolContext): Promise<ChatToolOutcome> {
  const i = (input && typeof input === 'object' ? input : {}) as Bag
  switch (name) {
    case 'check_availability': return availability(i)
    case 'get_quote': return quote(i, ctx)
    case 'find_account': return findAccount(i)
    case 'find_contacts': return findContacts(i)
    case 'place_hold': return book(i, ctx)
    default: return fail(`Unknown tool ${name}`)
  }
}

async function availability(i: Bag): Promise<ChatToolOutcome> {
  const q = quoteInput(i)
  if (typeof q === 'string') return fail(q)
  const resolved = await resolveQuoteMarket(q.market)
  if ('status' in resolved) return { content: json(resolved.body), isError: true }
  const defaults = await resolveDefaultRateOverrides()
  const a = await checkAvailability({
    market: resolved.formal,
    startDate: q.start_date,
    endDate: q.end_date,
    truckCount: q.truck_count,
    serviceAreaMiles: defaults?.service_area_miles,
    // The staff rule, as on the quote page: leaving a later AT&T soft hold short is a warning.
    softHoldStrandIsWarning: true,
  })
  if (!a.marketResolved) return fail(`Could not locate "${resolved.formal}" on the map.`)
  return {
    content: json({
      market: resolved.formal,
      requested: q.truck_count,
      sufficient: a.sufficient,
      counts: a.counts,
      // Ranked nearest first. needsAttSoftRelease trucks are never picked by a
      // quote on their own: an AT&T soft hold has to be released for them.
      trucks: a.trucks.slice(0, 25).map(t => ({
        truck: t.truckNumber,
        releasedFrom: t.currentMarket || 'Unknown',
        miles: Math.round(t.distanceMiles),
        proximity: t.proximityBucket,
        needsAttSoftRelease: t.requiresOverride,
        note: t.overrideDetail || t.softHoldWarning || undefined,
      })),
      cannotTake: a.infeasible.slice(0, 25).map(t => ({
        truck: t.truckNumber, from: t.currentMarket || 'Unknown', reason: t.reason, detail: t.detail,
        earliestStart: t.earliestStart, latestEnd: t.latestEnd,
      })),
      dateOptions: a.dateOptions,
    }),
  }
}

async function quote(i: Bag, ctx: ChatToolContext): Promise<ChatToolOutcome> {
  const q = quoteInput(i)
  if (typeof q === 'string') return fail(q)
  const started = Date.now()
  const result = await staffQuote(q)
  recordToolRun(ctx.actor, 'quote_chat', q, result.status, result.body, Date.now() - started)
  const body = result.body
  if (result.status !== 200 || body.insufficient === true || typeof body.grandTotal !== 'number') {
    return { content: json(body), isError: result.status !== 200 }
  }
  // The ref covers the market as the quote resolved it: that is what place_hold books.
  const ref = quoteRef({ ...q, market: String(body.market) }, body.grandTotal)
  const trucks = Array.isArray(body.selectedTrucks) ? body.selectedTrucks.join(', ') : ''
  return {
    content: json({ ...body, quote_ref: ref }),
    quote: { ref, summary: `${body.market}, ${q.start_date} to ${q.end_date}, ${q.truck_count} truck${q.truck_count === 1 ? '' : 's'}${trucks ? ` (${trucks})` : ''}, ${money(body.grandTotal)}` },
  }
}

async function findAccount(i: Bag): Promise<ChatToolOutcome> {
  if (!isSfdcConfigured()) return fail('Salesforce is not configured.')
  if (!isStr(i.query) || i.query.trim().length < 2) return fail('query needs at least 2 characters')
  try {
    return { content: json({ accounts: await searchAccounts(i.query.trim()) }) }
  } catch (err) {
    console.error('[chat] account search failed:', err)
    return fail('Salesforce could not be reached for the account search.')
  }
}

async function findContacts(i: Bag): Promise<ChatToolOutcome> {
  if (!isSfdcConfigured()) return fail('Salesforce is not configured.')
  if (!(typeof i.account_id === 'string' && isAccountId(i.account_id))) return fail('account_id must be a Salesforce Account id from find_account')
  try {
    return { content: json({ contacts: await searchContacts(i.account_id, typeof i.query === 'string' ? i.query.trim() : '') }) }
  } catch (err) {
    console.error('[chat] contact search failed:', err)
    return fail('Salesforce could not be reached for the contact search.')
  }
}

async function book(i: Bag, ctx: ChatToolContext): Promise<ChatToolOutcome> {
  if (ctx.booked) return fail('One booking attempt per message. Tell the rep what happened and ask before trying again.')
  const q = quoteInput(i)
  if (typeof q === 'string') return fail(q)
  if (!q.sfdc_account_id) return fail('sfdc_account_id is required: find the account with find_account.')
  if (!isStr(i.sfdc_account_name)) return fail('sfdc_account_name is required.')
  if (!isStr(i.quote_ref) || typeof i.expected_total !== 'number' || !Number.isFinite(i.expected_total)) {
    return fail('quote_ref and expected_total come from get_quote.')
  }
  if (i.hold_days !== undefined && (typeof i.hold_days !== 'number' || !Number.isInteger(i.hold_days))) return fail('hold_days is a whole number of days')
  if (i.brand !== undefined && typeof i.brand !== 'string') return fail('brand is text')
  // The rep confirms what was quoted, nothing else: same inputs and total, and
  // a quote they were shown before this message.
  if (quoteRef(q, i.expected_total) !== i.quote_ref.trim()) {
    return fail('These inputs or this total are not the quote with that ref. Run get_quote with the exact inputs to book, show it to the rep with its ref, and ask them to confirm.')
  }
  if (!ctx.shownText.includes(i.quote_ref.trim())) {
    return fail('The rep has not seen this quote yet. Show it with its quote ref and ask them to confirm; book when they reply.')
  }
  ctx.booked = true
  const body = {
    ...q,
    sfdc_account_name: i.sfdc_account_name.trim(),
    primary_contact_id: i.primary_contact_id,
    brand: i.brand,
    hold_days: i.hold_days,
    stage: i.stage,
    expected_total: i.expected_total,
  }
  const started = Date.now()
  const result = await placeStaffBooking(body, ctx.actor)
  recordToolRun(ctx.actor, 'hold_chat', body, result.status, result.body, Date.now() - started)
  const ok = result.status === 200 && result.body.ok === true
  const message = String((ok ? result.body.message : result.body.error) ?? 'The booking failed.')
  return {
    content: json(result.body),
    isError: !ok,
    action: { success: ok, message: ok ? message : `Not booked: ${message}` },
  }
}

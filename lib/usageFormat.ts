/**
 * Usage log labels and one-line descriptions — browser-safe (no database), so
 * the Usage page and the server share them. See lib/usageLog.ts.
 */

export type UsageTool =
  | 'quote_classic' | 'quote_multi' | 'quote_client' | 'quote_chat'
  | 'hold_classic' | 'hold_multi' | 'hold_client' | 'hold_chat'
  | 'quote_client_multi' | 'hold_client_multi'
  | 'ai_chat_staff' | 'ai_chat_client' | 'ai_plan_areas' | 'ai_plan_review'

export const TOOL_LABELS: Record<UsageTool, string> = {
  // The Quote Builder's /api/quote and /api/quote/hold; the key predates the
  // Classic Quote Tool's removal and stays so older rows keep their label.
  // Pricing runs save nothing (no opportunity, no hold): a price check.
  quote_classic: 'Quote price check (Quote Builder)',
  quote_multi: 'Quote price check (Multi-market)',
  quote_client: 'Quote price check (client portal)',
  quote_chat: 'Quote price check (AI chat)',
  hold_classic: 'Hold placed (Quote Builder)',
  hold_multi: 'Hold placed (Multi-market)',
  hold_client: 'Hold placed (client portal)',
  hold_chat: 'Hold placed (AI chat)',
  quote_client_multi: 'Quote price check (client portal, multi-market)',
  hold_client_multi: 'Hold placed (client portal, multi-market)',
  ai_chat_staff: 'AI chat (staff)',
  ai_chat_client: 'AI chat (client portal)',
  ai_plan_areas: 'AI: ZIP list → areas',
  ai_plan_review: 'AI: plan review',
}

/** MCP tool names; logged as tool "mcp_<name>" (lib/usageLog.ts recordMcpUsage). */
export const MCP_TOOL_LABELS: Record<string, string> = {
  list_inventory: 'MCP: list inventory',
  check_availability: 'MCP: check availability',
  get_rate_quote: 'MCP: rate quote',
  get_service_area: 'MCP: service area',
  request_hold: 'MCP: request hold',
  book_campaign: 'MCP: book campaign',
}

export const toolLabel = (tool: string) =>
  (TOOL_LABELS as Record<string, string>)[tool] ?? MCP_TOOL_LABELS[tool.replace(/^mcp_/, '')] ?? tool

/**
 * One run's label. A quote-only submit goes through the same hold route as a
 * real hold, but it reserves nothing: "Quote only, no reservation (Quote
 * Builder)", not "Hold placed". It doesn't claim the Salesforce log worked:
 * the outcome shows a run that errored, and a Salesforce failure on a run that
 * otherwise succeeded is in the row's result text. The result's quote_only
 * (lib/usageLog.ts summarizeResult) marks it; rows logged before that fall
 * back to the request's own quote-only flag, or the backfill's note.
 */
export function runLabel(tool: string, result?: Bag | null, inputs?: Bag | null): string {
  return isQuoteOnlyRun(tool, result, inputs) ? QUOTE_ONLY_RUNS[tool].label : toolLabel(tool)
}

/**
 * Whether a run logged a quote only. Only the two routes that honour the flag
 * count, each by its own spelling of it, so a flag sent to a route that
 * ignores it (client portal, chat) never relabels a real hold.
 */
export function isQuoteOnlyRun(tool: string, result?: Bag | null, inputs?: Bag | null): boolean {
  const run = Object.hasOwn(QUOTE_ONLY_RUNS, tool) ? QUOTE_ONLY_RUNS[tool] : undefined
  return !!run && (result?.quote_only === true || inputs?.[run.flag] === true || result?.note === BACKFILL_QUOTE_ONLY_NOTE)
}

/** How the usage-log backfill (prisma/migrations/20261005200000_usage_record_conversations_last_activity) marked a quote-only booking. */
export const BACKFILL_QUOTE_ONLY_NOTE = 'quote only, nothing reserved'

/** The hold routes that can log a quote only: the request flag each reads, and how such a run reads. */
const QUOTE_ONLY_RUNS: Record<string, { flag: string; label: string }> = {
  hold_classic: { flag: 'quote_only', label: 'Quote only, no reservation (Quote Builder)' },
  hold_multi: { flag: 'quoteOnly', label: 'Quote only, no reservation (Multi-market)' },
}

/**
 * The Usage page's Tool filter. A quote-only submit is logged under the same
 * tool as a real hold, so filtering by tool alone listed quotes under "Hold
 * placed". Each hold tool that can log a quote only gets a second option, and
 * the "Hold placed" option leaves quote-only runs out.
 */
export const QUOTE_ONLY_FILTERS: Record<string, string> = {
  quote_only_classic: 'hold_classic',
  quote_only_multi: 'hold_multi',
}

/** The Tool filter's options, in the order the page lists them (browser-safe). */
export function toolFilterOptions(): { v: string; l: string }[] {
  return [
    ...Object.entries(TOOL_LABELS).flatMap(([v, l]) => {
      const qo = Object.entries(QUOTE_ONLY_FILTERS).find(([, tool]) => tool === v)
      return qo ? [{ v, l }, { v: qo[0], l: QUOTE_ONLY_RUNS[v].label }] : [{ v, l }]
    }),
    { v: 'mcp', l: 'MCP: all tools' },
    ...Object.entries(MCP_TOOL_LABELS).map(([k, l]) => ({ v: `mcp_${k}`, l })),
  ]
}

/**
 * What a Tool filter value selects: the logged tool ('mcp' for every MCP
 * tool), and whether only quote-only runs (true), only real holds (false), or
 * every run (null) of it. Pure.
 */
export function parseToolFilter(value: string | null): { tool: string | null; quoteOnly: boolean | null } {
  if (!value) return { tool: null, quoteOnly: null }
  if (Object.hasOwn(QUOTE_ONLY_FILTERS, value)) return { tool: QUOTE_ONLY_FILTERS[value], quoteOnly: true }
  if (Object.hasOwn(QUOTE_ONLY_RUNS, value)) return { tool: value, quoteOnly: false }
  return { tool: value, quoteOnly: null }
}

type Bag = Record<string, unknown>
const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const day = (iso?: string) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? new Date(iso.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : undefined)
const range = (a?: string, b?: string) => {
  if (!a || !b) return day(a ?? b)
  if (a.slice(0, 10) === b.slice(0, 10)) return day(a)
  // Same month: "Oct 7–11"; otherwise "Oct 28–Nov 3".
  return a.slice(0, 7) === b.slice(0, 7) ? `${day(a)}–${Number(b.slice(8, 10))}` : `${day(a)}–${day(b)}`
}

/** "Dallas, TX · Oct 7–11 · 2 trucks · Acme" — what a run was about. */
export function describeInputs(inputs: Bag | null | undefined): string {
  if (!inputs) return ''
  const i = inputs
  const rows = Array.isArray(i.rows) ? (i.rows as Bag[]) : (i.rows as Bag | undefined)?.first as Bag[] | undefined
  const parts: (string | undefined)[] = []
  if (rows?.length) {
    parts.push(`${rows.length} market${rows.length === 1 ? '' : 's'}: ${rows.slice(0, 3).map(r => s(r.market)).filter(Boolean).join(', ')}${rows.length > 3 ? '…' : ''}`)
  } else {
    parts.push(s(i.market) ?? s(i.campaign_city))
    parts.push(range(s(i.start_date) ?? s(i.startDate), s(i.end_date) ?? s(i.endDate)))
    const trucks = n(i.truck_count) ?? n(i.trucks)
    if (trucks) parts.push(`${trucks} truck${trucks === 1 ? '' : 's'}`)
  }
  parts.push(s(i.sfdc_account_name) ?? s(i.sfdcAccountName), s(i.brand))
  const msg = s(i.message) ?? s(i.question)
  if (msg) parts.push(`“${msg.length > 80 ? msg.slice(0, 80) + '…' : msg}”`)
  return parts.filter(Boolean).join(' · ')
}

/** "$12,400 · 3 holds" or the refusal — what came out. */
export function describeResult(result: Bag | null | undefined): string {
  if (!result) return ''
  const money = (v: unknown) => (n(v) !== undefined ? `$${Math.round(n(v)!).toLocaleString('en-US')}` : undefined)
  return [
    money(result.total) ?? money(result.grand_total) ?? money(result.best_total) ?? money(result.good_total),
    n(result.holds) !== undefined ? `${result.holds} hold${result.holds === 1 ? '' : 's'}` : n(result.hold_count) !== undefined ? `${result.hold_count} holds` : undefined,
    n(result.areas) !== undefined ? `${result.areas} areas` : undefined,
    n(result.findings) !== undefined ? `${result.findings} findings` : undefined,
    result.insufficient === true ? 'not enough trucks' : undefined,
    s(result.error),
  ].filter(Boolean).join(' · ')
}

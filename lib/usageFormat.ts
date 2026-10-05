/**
 * Usage log labels and one-line descriptions — browser-safe (no database), so
 * the Usage page and the server share them. See lib/usageLog.ts.
 */

export type UsageTool =
  | 'quote_classic' | 'quote_multi' | 'quote_client'
  | 'hold_classic' | 'hold_multi' | 'hold_client'
  | 'ai_chat_staff' | 'ai_chat_client' | 'ai_plan_areas' | 'ai_plan_review'

export const TOOL_LABELS: Record<UsageTool, string> = {
  quote_classic: 'Quote (Classic)',
  quote_multi: 'Quote (Multi-market)',
  quote_client: 'Quote (client portal)',
  hold_classic: 'Hold placed (Classic)',
  hold_multi: 'Hold placed (Multi-market)',
  hold_client: 'Hold placed (client portal)',
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

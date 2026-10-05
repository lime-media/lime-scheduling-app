/**
 * The usage log: what is stored about each run, and how it reads.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { outcomeFor, pruneFormEntries, pruneInputs, reportFields, summarizeResult } from '@/lib/usageLog'
import { describeInputs, describeResult, toolLabel } from '@/lib/usageFormat'

section('usage log: inputs kept')
eq('primitives kept', pruneInputs({ market: 'Ames, IA', truck_count: 2, shadow_fencing: true }), { market: 'Ames, IA', truck_count: 2, shadow_fencing: true })
eq('secrets never stored', Object.keys(pruneInputs({ market: 'x', password: 'hunter2', mcp_token: 't', otp: '123' })), ['market'])
eq('a long chat message is clipped to 500', String(pruneInputs({ message: 'a'.repeat(900) }).message).startsWith('a'.repeat(500) + '… (900 chars)'), true)
eq('other strings to 200', String(pruneInputs({ market: 'b'.repeat(300) }).market).length < 230, true)
eq('a long list keeps the first 20 and the count', (pruneInputs({ rows: Array.from({ length: 30 }, (_, i) => ({ market: `M${i}` })) }).rows as { count: number }).count, 30)
eq('list items lose nested objects', pruneInputs({ rows: [{ market: 'Dallas', extra: { deep: 1 } }] }).rows, [{ market: 'Dallas' }])
eq('not an object: nothing', pruneInputs('hello'), {})
eq('review: every credential and personal-ID key is dropped',
  Object.keys(pruneInputs({ market: 'x', authorization: 'Bearer sk', apiKey: 'sk', api_key: 'sk', pwd: 'p', passwd: 'p', credentials: 'u:p', ssn: '1', sessionId: 's', cookie: 'c', privateKey: 'k' })), ['market'])
eq('...including inside list items', pruneInputs({ rows: [{ market: 'Dallas', apiKey: 'sk' }] }).rows, [{ market: 'Dallas' }])

section('usage log: result headline')
eq('a Classic quote', summarizeResult({ grandTotal: 3800, market: 'Ames, IA', presets: { good: { total: 2700 }, best: { total: 3800 } } }), { total: 3800, good: 2700, best: 3800, market: 'Ames, IA' })
eq('a multi-market quote', summarizeResult({ quote: { summary: { grandTotal: 41000, markets: 3, trucksUsed: 4 } } }), { total: 41000, markets: 3, trucks: 4 })
eq('holds placed', summarizeResult({ created: [{}, {}], failed: [] }), { holds: 2, failed: 0 })
eq('not enough trucks', summarizeResult({ insufficient: true, message: 'Automatic quote not feasible' }).insufficient, true)
eq('an error', summarizeResult({ error: 'Invalid JSON' }), { error: 'Invalid JSON' })

section('usage log: outcome')
eq('200 is success', outcomeFor(200, { grandTotal: 1 }), 'success')
eq('not enough trucks is not feasible', outcomeFor(200, { insufficient: true }), 'not_feasible')
eq('4xx is refused', outcomeFor(409, { error: 'x' }), 'refused')
eq('review: ok:false on a 200 is not read as "not feasible"', outcomeFor(200, { ok: false }), 'success')
eq('5xx is an error', outcomeFor(502, null), 'error')

section('usage page: one-line descriptions')
eq('a single-market quote', describeInputs({ market: 'Ames, IA', start_date: '2026-10-07', end_date: '2026-10-11', truck_count: 2, sfdc_account_name: 'Acme', brand: 'Nike' }), 'Ames, IA · Oct 7–11 · 2 trucks · Acme · Nike')
eq('a multi-market quote', describeInputs({ rows: [{ market: 'Dallas, TX' }, { market: 'Austin, TX' }] }), '2 markets: Dallas, TX, Austin, TX')
eq('a chat', describeInputs({ message: 'Which trucks are free in Denver next week?' }), '“Which trucks are free in Denver next week?”')
eq('a result', describeResult({ total: 3800.4, holds: 1 }), '$3,800 · 1 hold')
eq('a refusal', describeResult({ insufficient: true, error: 'Automatic quote not feasible' }), 'not enough trucks · Automatic quote not feasible')
eq('an MCP result', describeResult({ best_total: 12000 }), '$12,000')
eq('tool names', [toolLabel('quote_classic'), toolLabel('get_rate_quote'), toolLabel('something_new')], ['Quote (Classic)', 'MCP: rate quote', 'something_new'])

section('usage log: file uploads are redacted the same way')
eq('the field kept, the key dropped, the file as name + size',
  pruneFormEntries([['label', 'Acme DMAs'], ['apiKey', 'sk-live-xyz'], ['file', { name: 'zips.csv', size: 7 }]]),
  { label: 'Acme DMAs', file: { file: 'zips.csv', bytes: 7 } })

section('usage log: one table for everything')
eq('MCP tools are labelled from their logged name', toolLabel('mcp_get_rate_quote'), 'MCP: rate quote')
eq('a chat links its conversation instead of copying it', summarizeResult({ reply: 'ok', conversation_id: '1747E4A2-4C43-47B1-B2C9-65B7B444AACF' }).conversation_id, '1747E4A2-4C43-47B1-B2C9-65B7B444AACF')
eq('a preview is still a preview', String(summarizeResult({ reply: 'x'.repeat(2400) }).reply).startsWith('x'.repeat(300) + '…'), true)
eq('an assistance request the chat filed is kept', summarizeResult({ reply: 'ok', actionResult: { success: true, message: 'Request sent to the team.' } }).action, 'Request sent to the team.')
eq('an MCP quote reads like any other', describeInputs({ campaign_city: 'Phoenix, AZ', start_date: '2026-09-01', end_date: '2026-09-21' }), 'Phoenix, AZ · Sep 1–21')

section('usage log: reportable columns')
eq('a Classic quote', reportFields({ market: 'Ames, IA', sfdc_account_name: 'Acme' }, { total: 3800, holds: 1 }),
  { market: 'Ames, IA', account: 'Acme', total: 3800, holds: 1, conversation_id: null })
eq('a Multi-market quote', reportFields({ rows: [{ market: 'Dallas, TX' }, { market: 'Austin, TX' }], sfdcAccountName: 'Acme' }, { total: 41000 }).market, '2 markets')
eq('a client run is on its own account', reportFields({ market: 'Dallas, TX' }, {}, { type: 'client_user', id: 'c1', name: 'Firefly (firefly)' }).account, 'Firefly (firefly)')
eq('an MCP quote', reportFields({ campaign_city: 'Phoenix, AZ' }, { grand_total: 91350 }), { market: 'Phoenix, AZ', account: null, total: 91350, holds: null, conversation_id: null })
eq('a chat: its conversation', reportFields({ message: 'hi' }, { reply: 'ok', conversation_id: 'abc' }).conversation_id, 'abc')
eq('nothing: all null', reportFields(null, null), { market: null, account: null, total: null, holds: null, conversation_id: null })
eq('review: presets only (no grand total) still fills total, from best', reportFields({}, summarizeResult({ presets: { good: { total: 3500 }, best: { total: 4200 } } })).total, 4200)

section('usage log: the Multi-market quote as /api/plan/quote actually returns it')
eq('total, markets and trucks from summary (production shape)',
  summarizeResult({ lines: [], summary: { grandTotal: 52400, markets: 2, trucksUsed: 4 }, itineraries: [], alternatives: [] }),
  { total: 52400, markets: 2, trucks: 4 })

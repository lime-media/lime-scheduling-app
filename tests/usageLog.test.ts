/**
 * The usage log: what is stored about each run, and how it reads.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { outcomeFor, pruneInputs, summarizeResult } from '@/lib/usageLog'
import { describeInputs, describeResult, toolLabel } from '@/lib/usageFormat'

section('usage log: inputs kept')
eq('primitives kept', pruneInputs({ market: 'Ames, IA', truck_count: 2, shadow_fencing: true }), { market: 'Ames, IA', truck_count: 2, shadow_fencing: true })
eq('secrets never stored', Object.keys(pruneInputs({ market: 'x', password: 'hunter2', mcp_token: 't', otp: '123' })), ['market'])
eq('a long chat message is clipped to 500', String(pruneInputs({ message: 'a'.repeat(900) }).message).startsWith('a'.repeat(500) + '… (900 chars)'), true)
eq('other strings to 200', String(pruneInputs({ market: 'b'.repeat(300) }).market).length < 230, true)
eq('a long list keeps the first 20 and the count', (pruneInputs({ rows: Array.from({ length: 30 }, (_, i) => ({ market: `M${i}` })) }).rows as { count: number }).count, 30)
eq('list items lose nested objects', pruneInputs({ rows: [{ market: 'Dallas', extra: { deep: 1 } }] }).rows, [{ market: 'Dallas' }])
eq('not an object: nothing', pruneInputs('hello'), {})

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
eq('5xx is an error', outcomeFor(502, null), 'error')

section('usage page: one-line descriptions')
eq('a single-market quote', describeInputs({ market: 'Ames, IA', start_date: '2026-10-07', end_date: '2026-10-11', truck_count: 2, sfdc_account_name: 'Acme', brand: 'Nike' }), 'Ames, IA · Oct 7–11 · 2 trucks · Acme · Nike')
eq('a multi-market quote', describeInputs({ rows: [{ market: 'Dallas, TX' }, { market: 'Austin, TX' }] }), '2 markets: Dallas, TX, Austin, TX')
eq('a chat', describeInputs({ message: 'Which trucks are free in Denver next week?' }), '“Which trucks are free in Denver next week?”')
eq('a result', describeResult({ total: 3800.4, holds: 1 }), '$3,800 · 1 hold')
eq('a refusal', describeResult({ insufficient: true, error: 'Automatic quote not feasible' }), 'not enough trucks · Automatic quote not feasible')
eq('an MCP result', describeResult({ best_total: 12000 }), '$12,000')
eq('tool names', [toolLabel('quote_classic'), toolLabel('get_rate_quote'), toolLabel('something_new')], ['Quote (Classic)', 'MCP: rate quote', 'something_new'])

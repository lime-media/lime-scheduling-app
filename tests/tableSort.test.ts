/**
 * List sorting (lib/tableSort.ts).
 * Run with: npm test
 */
import { eq, section } from './harness'
import { minValue, nextSort, sortRows } from '@/lib/tableSort'

type R = { truck: string; total: number | null; expires: string | null }
const rows: R[] = [
  { truck: '1043', total: 9000, expires: '2026-10-20' },
  { truck: '987', total: null, expires: null },
  { truck: '1102', total: 1500, expires: '2026-10-14' },
  { truck: '0042', total: 9000, expires: '' },
]
const v = (r: R, k: 'truck' | 'total' | 'expires') => r[k]
const trucks = (xs: R[]) => xs.map(x => x.truck)

section('table sort: numbers, blanks, stability')
eq('no sort keeps the API order', trucks(sortRows(rows, null, v)), ['1043', '987', '1102', '0042'])
eq('truck numbers sort as numbers, not text', trucks(sortRows(rows, { by: 'truck', dir: 'asc' }, v)), ['0042', '987', '1043', '1102'])
eq('descending', trucks(sortRows(rows, { by: 'truck', dir: 'desc' }, v)), ['1102', '1043', '987', '0042'])
eq('money ascending, blank last', trucks(sortRows(rows, { by: 'total', dir: 'asc' }, v)), ['1102', '1043', '0042', '987'])
eq('ties keep their order either way', trucks(sortRows(rows, { by: 'total', dir: 'desc' }, v)), ['1043', '0042', '1102', '987'])
eq('blank and empty dates last, descending too', trucks(sortRows(rows, { by: 'expires', dir: 'desc' }, v)), ['1043', '1102', '987', '0042'])
eq('the input is not reordered', trucks(rows), ['1043', '987', '1102', '0042'])
eq('text ignores case', sortRows([{ n: 'beta' }, { n: 'Alpha' }], { by: 'n', dir: 'asc' }, (r, k: 'n') => r[k]).map(r => r.n), ['Alpha', 'beta'])

section('table sort: header clicks')
eq('new column starts ascending', nextSort({ by: 'truck', dir: 'desc' }, 'total'), { by: 'total', dir: 'asc' })
eq('same column flips', nextSort({ by: 'truck', dir: 'asc' }, 'truck'), { by: 'truck', dir: 'desc' })
eq('and flips back', nextSort({ by: 'truck', dir: 'desc' }, 'truck'), { by: 'truck', dir: 'asc' })
eq('first click ascending', nextSort(null, 'truck'), { by: 'truck', dir: 'asc' })

section('table sort: a campaign sorts by its lowest truck')
eq('lowest truck number, numerically', minValue(['1043', '987', '1102']), '987')
eq('all blank is blank', minValue([null, '']), null)

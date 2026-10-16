/**
 * Multi-market quote rows: copying dates down (lib/planner/rows.ts).
 * Run with: npm test
 */
import { eq, section } from './harness'
import { copyDatesDown } from '@/lib/planner/rows'

const row = (id: string, startDate = '', endDate = '', trucks = 1) => ({ id, startDate, endDate, trucks })
const rows = [row('a', '2026-11-02', '2026-11-18', 2), row('b'), row('c', '2026-12-01', '2026-12-05', 3), row('d')]
const dates = (rs: typeof rows) => rs.map(r => `${r.id}:${r.startDate}..${r.endDate}`)

section('planner: copy dates down')
eq('from the first row: every row below gets its dates',
  dates(copyDatesDown(rows, 'a')), ['a:2026-11-02..2026-11-18', 'b:2026-11-02..2026-11-18', 'c:2026-11-02..2026-11-18', 'd:2026-11-02..2026-11-18'])
eq('only dates: trucks stay per row', copyDatesDown(rows, 'a').map(r => r.trucks), [2, 1, 3, 1])
eq('from a middle row: rows above are left alone',
  dates(copyDatesDown(rows, 'c')), ['a:2026-11-02..2026-11-18', 'b:..', 'c:2026-12-01..2026-12-05', 'd:2026-12-01..2026-12-05'])
eq('a row without both dates copies nothing', copyDatesDown(rows, 'b'), rows)
eq('unknown row: unchanged', copyDatesDown(rows, 'zz'), rows)
eq('rows that already match keep their identity', copyDatesDown(rows, 'c')[0] === rows[0], true)
eq('the input is not changed', rows[1].startDate, '')

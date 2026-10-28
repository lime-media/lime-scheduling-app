/**
 * A LED shift's day is its date in its market's time zone (lib/scheduleQuery.ts
 * shiftDay): LED stores shift times in UTC.
 *
 * Run with: npm test
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { eq, section } from './harness'
import { CHAT_CONTEXT_QUERY, SCHEDULED_QUERY, liveProgram, scheduledWithMarketQuery, shiftDay, shiftDayIn } from '@/lib/scheduleQuery'

section('shiftDay: UTC to the market\'s local date')
const sql = shiftDay('ps.start_time')
eq('reads the column as UTC', sql.startsWith("CAST(ps.start_time AT TIME ZONE 'UTC' AT TIME ZONE"), true)
eq('Eastern', sql.includes("WHEN 'America/New_York'    THEN 'Eastern Standard Time'"), true)
eq('Pacific', sql.includes("WHEN 'America/Los_Angeles' THEN 'Pacific Standard Time'"), true)
eq('LED\'s Mountain (Creston) has no DST', sql.includes("WHEN 'America/Creston'     THEN 'US Mountain Standard Time'"), true)
eq('no market: Central', sql.includes("ELSE 'Central Standard Time' END AS DATE)"), true)
eq('uses the alias it is given', shiftDay('ps_lk.start_time', 'pm_lk').includes('CASE pm_lk.market_timezone'), true)

section('shiftDayIn: a raw UTC range first, so start_time stays indexed')
const both = shiftDayIn({ from: '@from', to: '@to' })
eq('UTC lower bound a day early', both.includes('ps.start_time >= DATEADD(day, -1, @from)'), true)
eq('UTC upper bound a day late', both.includes('ps.start_time < DATEADD(day, 2, @to)'), true)
eq('then the local day, both ends', both.includes(`${shiftDay('ps.start_time')} >= @from`) && both.includes(`${shiftDay('ps.start_time')} <= @to`), true)
eq('one bound only', shiftDayIn({ to: '@asOf' }).includes('>='), false)
eq('a column bound takes its raw range from `near`, a day wider', shiftDayIn({ to: 'pm.x' }, 'ps', 'pm', 'T').startsWith('ps.start_time < DATEADD(day, 3, T)'), true)
eq('other aliases', shiftDayIn({ from: 'x' }, 'ps_lk', 'pm_lk').startsWith('ps_lk.start_time >= DATEADD(day, -1, x)'), true)

section('no LED query reads a UTC date any more')
// A guard against the known regression, not a proof: it matches the one
// spelling the bug had (CAST(x.start_time AS DATE)), in files that name
// program_schedule, from the repo root. A CONVERT, other whitespace, or a query
// assembled elsewhere would slip past.
// Every file that reads program_schedule: a CAST of a shift time to DATE is the
// UTC date, and filtering on shiftDay alone can't use the start_time index.
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [])
for (const file of [...files('lib'), ...files('app')].filter(f => readFileSync(f, 'utf8').includes('program_schedule'))) {
  const src = readFileSync(file, 'utf8')
  eq(`${file}: no CAST(..._time AS DATE)`, /CAST\(\w+\.(start|end)_time\s+AS DATE\)/.test(src), false)
  eq(`${file}: no shiftDay of end_time`, /shiftDay\('\w+\.end_time'/.test(src), false)
  eq(`${file}: no shiftDay filter without its UTC range`, /\$\{shiftDay\('[^}]*\)\}\s*(>=|<=|<|>|BETWEEN)/.test(src), false)
}
for (const [name, q] of Object.entries({ SCHEDULED_QUERY, CHAT_CONTEXT_QUERY, windowed: scheduledWithMarketQuery(true, true), rolling: scheduledWithMarketQuery(false, false) })) {
  eq(`${name}: no GETDATE()`, q.includes('GETDATE()'), false)
}

section('an archived LED program\'s future shifts book no truck')
// LED's archive leaves a program's shifts in place, so every query that reads
// program_schedule to decide whether a truck is taken applies liveProgram,
// one call per read. The exceptions read where a truck last worked (a past
// shift, which liveProgram keeps anyway): listed here by file.
const LOCATION_ONLY = new Map([['lib/scheduleQuery.ts', 1], ['lib/attSoftHolds.ts', 1]])
for (const file of [...files('lib'), ...files('app')]) {
  const src = readFileSync(file, 'utf8')
  const reads = (src.match(/(FROM|JOIN)\s+\(?\s*dbo\.program_schedule\b/g) ?? []).length - (LOCATION_ONLY.get(file) ?? 0)
  if (reads <= 0) continue
  eq(`${file}: one liveProgram per program_schedule read`, (src.match(/\$\{liveProgram\(/g) ?? []).length, reads)
}
const live = liveProgram('p', 'ps2')
eq('keeps a live program, or a shift with no program row', live.startsWith('(COALESCE(p.is_deleted, 0) = 0 OR '), true)
eq('keeps shifts that already started (history), archived or not', live.endsWith('OR ps2.start_time < SYSUTCDATETIME())'), true)
for (const [name, q] of Object.entries({ SCHEDULED_QUERY, CHAT_CONTEXT_QUERY, windowed: scheduledWithMarketQuery(true, true), rolling: scheduledWithMarketQuery(false, false) })) {
  eq(`${name}: leaves out an archived program's future shifts`, q.includes('.is_deleted, 0) = 0 OR ') && q.includes('.start_time < SYSUTCDATETIME())'), true)
}

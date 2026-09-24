/**
 * Fleet usage history — the demand a new program has to live alongside.
 *
 * Weekly distinct trucks working over the last 52 weeks, split three ways:
 * the reserved client's core programs (AT&T), its renewing programs (Alloy
 * Build, when marked), and every other client. Maintenance is excluded — it is
 * held back separately.
 *
 * Grouped by booking client, not program name. Counting AT&T by program name
 * was how Alloy Build first got counted as "another client".
 */

import { query } from '@/lib/mssql'
import { daysBetween } from './planner'

export type WeeklyUsage = { week: string; reservedCore: number; renewing: number; other: number }

export type UsageSummary = {
  weeks: WeeklyUsage[]
  reservedCore: { median: number; p25: number; p75: number }
  renewingRecent: number
  other: { winter: number; spring: number; summer: number; max: number }
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const r1 = (x: number) => Math.round(x * 10) / 10

export async function loadUsageHistory(opts: {
  today: string
  reservedClients: string[]
  renewingPrograms: string[]
  hiddenTrucks: Set<string>
}): Promise<UsageSummary> {
  const params: Record<string, unknown> = {}
  // "contains" matches, same as the fleet reservation rules.
  const contains = (column: string, prefix: string, values: string[]) => {
    if (values.length === 0) return '1 = 0'
    return '(' + values.map((v, i) => { params[`${prefix}${i}`] = `%${v}%`; return `${column} LIKE @${prefix}${i}` }).join(' OR ') + ')'
  }
  const clients = contains('cl.client', 'c', opts.reservedClients)
  const programs = contains('cp.program', 'p', opts.renewingPrograms)
  const hidden = [...opts.hiddenTrucks].map((t, i) => { params[`h${i}`] = t; return `@h${i}` })
  params.today = opts.today

  const rows = await query<{ week: Date | string; reserved_core: number; renewing: number; other: number }[]>(`
WITH days AS (
  SELECT DISTINCT ps.truck_uid,
         CAST(ps.start_time AS DATE) AS d,
         CASE
           WHEN ${clients} AND ${programs} THEN 'renewing'
           WHEN ${clients} THEN 'reserved_core'
           ELSE 'other'
         END AS grp
  FROM dbo.program_schedule ps
  JOIN dbo.trucks t ON t.truck_uid = ps.truck_uid
  LEFT JOIN dbo.client_programs cp ON cp.client_program_uid = ps.client_program_uid
  LEFT JOIN dbo.clients cl ON cl.client_uid = cp.client_uid
  -- The same fleet the planner uses: not archived, not hidden.
  WHERE COALESCE(t.is_deleted, 0) = 0${hidden.length ? `
    AND t.truck_number NOT IN (${hidden.join(', ')})` : ''}
    AND CAST(ps.start_time AS DATE) >= DATEADD(week, -52, CAST(@today AS DATE))
    AND CAST(ps.start_time AS DATE) <  CAST(@today AS DATE)
    AND COALESCE(cp.program, '') NOT LIKE '%Maint%'
),
wk AS (
  SELECT truck_uid, grp, DATEADD(day, -((DATEPART(weekday, d) + @@DATEFIRST - 2) % 7), d) AS week
  FROM days
)
SELECT week,
       COUNT(DISTINCT CASE WHEN grp = 'reserved_core' THEN truck_uid END) AS reserved_core,
       COUNT(DISTINCT CASE WHEN grp = 'renewing'      THEN truck_uid END) AS renewing,
       COUNT(DISTINCT CASE WHEN grp = 'other'         THEN truck_uid END) AS other
FROM wk
GROUP BY week
ORDER BY week
`, params)

  const weeks: WeeklyUsage[] = rows
    .map(r => ({
      week: r.week instanceof Date ? r.week.toISOString().split('T')[0] : String(r.week).slice(0, 10),
      reservedCore: Number(r.reserved_core),
      renewing: Number(r.renewing),
      other: Number(r.other),
    }))
    // Drop the week still in progress; a partial week reads as a quiet one.
    .filter(w => daysBetween(w.week, opts.today) >= 7)

  // Holiday weeks (a handful of trucks out) would drag the core figure down.
  const core = weeks.map(w => w.reservedCore).filter(n => n >= 5)
  const month = (w: WeeklyUsage) => Number(w.week.slice(5, 7))
  const season = (ms: number[]) => r1(avg(weeks.filter(w => ms.includes(month(w))).map(w => w.other)))

  return {
    weeks,
    reservedCore: { median: r1(quantile(core, 0.5)), p25: r1(quantile(core, 0.25)), p75: r1(quantile(core, 0.75)) },
    renewingRecent: r1(avg(weeks.slice(-8).map(w => w.renewing))),
    other: {
      winter: season([10, 11, 12, 1, 2]),
      spring: season([3, 4, 5]),
      summer: season([6, 7, 8, 9]),
      max: Math.max(0, ...weeks.map(w => w.other)),
    },
  }
}

/**
 * A LED shift's day is its date in its market's time zone (lib/scheduleQuery.ts
 * shiftDay): LED stores shift times in UTC.
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { CHAT_CONTEXT_QUERY, SCHEDULED_QUERY, SCHEDULE_SUMMARY_QUERY, scheduledWithMarketQuery, shiftDay } from '@/lib/scheduleQuery'

section('shiftDay: UTC to the market\'s local date')
const sql = shiftDay('ps.start_time')
eq('reads the column as UTC', sql.startsWith("CAST(ps.start_time AT TIME ZONE 'UTC' AT TIME ZONE"), true)
eq('Eastern', sql.includes("WHEN 'America/New_York'    THEN 'Eastern Standard Time'"), true)
eq('Pacific', sql.includes("WHEN 'America/Los_Angeles' THEN 'Pacific Standard Time'"), true)
eq('LED\'s Mountain (Creston) has no DST', sql.includes("WHEN 'America/Creston'     THEN 'US Mountain Standard Time'"), true)
eq('no market: Central', sql.includes("ELSE 'Central Standard Time' END AS DATE)"), true)
eq('uses the alias it is given', shiftDay('ps_lk.start_time', 'pm_lk').includes('CASE pm_lk.market_timezone'), true)

section('no LED query reads a UTC date any more')
for (const [name, q] of Object.entries({ SCHEDULED_QUERY, CHAT_CONTEXT_QUERY, SCHEDULE_SUMMARY_QUERY, withMarket: scheduledWithMarketQuery(true, true) })) {
  eq(`${name}: no CAST(..._time AS DATE)`, /CAST\(\w+\.(start|end)_time\s+AS DATE\)/.test(q), false)
  eq(`${name}: no GETDATE()`, q.includes('GETDATE()'), false)
}

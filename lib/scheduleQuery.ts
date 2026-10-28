// Verified column names from Azure SQL (limemediauat) — confirmed via SELECT TOP 1 *:
//
//  dbo.trucks                  truck_id, truck_uid, truck_number, samsara_id, is_deleted
//  dbo.program_schedule        program_schedule_id, truck_uid, client_program_uid,
//                                client_program_market_uid, start_time, end_time
//  dbo.client_programs         client_program_id, client_program_uid, client_uid, program,
//                                description, program_color, start_date, end_date, is_deleted
//  dbo.client_program_markets  client_program_market_id, client_program_market_uid,
//                                client_program_uid, market, state, standard_market_uid,
//                                standard_market_name, market_timezone
//  GPS data is sourced from the Samsara API (lib/samsaraService.ts), not the DB.

// ── A shift's day ─────────────────────────────────────────────────────────────
// LED stores program_schedule.start_time / end_time in UTC, so CAST(... AS DATE)
// put an evening shift (from 7pm Central, 8pm Eastern) on the next day. A
// shift's day is its start's date in its market's time zone (an overnight
// shift belongs to the day it starts). LED keeps four zones on each market
// (Mountain as America/Creston, which has no DST); Phoenix and Denver are
// mapped too in case LED starts storing them. A shift with no market counts as
// Central. `market` is the alias of a joined dbo.client_program_markets.
const SQL_ZONE = (market: string) => `CASE ${market}.market_timezone
        WHEN 'America/New_York'    THEN 'Eastern Standard Time'
        WHEN 'America/Los_Angeles' THEN 'Pacific Standard Time'
        WHEN 'America/Creston'     THEN 'US Mountain Standard Time'
        WHEN 'America/Phoenix'     THEN 'US Mountain Standard Time'
        WHEN 'America/Denver'      THEN 'Mountain Standard Time'
        ELSE 'Central Standard Time' END`

/** SQL for today's date in Central time, the app's day (REVIEW.md); GETDATE() is UTC on Azure. */
const TODAY = `CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Central Standard Time' AS DATE)`

/** SQL for today's date in a market's own zone: a truck is "on today" by its market's clock. */
const todayIn = (market: string) => `CAST(SYSDATETIMEOFFSET() AT TIME ZONE ${SQL_ZONE(market)} AS DATE)`

/** SQL for the local date of a shift time column (`ps.start_time`), in its market's zone. */
export function shiftDay(time: string, market = 'cpm'): string {
  return `CAST(${time} AT TIME ZONE 'UTC' AT TIME ZONE ${SQL_ZONE(market)} AS DATE)`
}

/**
 * SQL that keeps the shifts whose day (`shiftDay` of start_time) is in
 * [from, to]; either bound may be left out. `from`/`to` are SQL dates. The raw
 * UTC bounds, a day wider (no US zone is more than a day from UTC), come first
 * so SQL Server can still seek on start_time: AT TIME ZONE can't use an index.
 * When a bound reads a column (a market's own today), `near` gives a date
 * within a day of it, without columns, for the raw bounds.
 */
export function shiftDayIn(range: { from?: string; to?: string }, ps = 'ps', market = 'cpm', near?: string): string {
  const time = `${ps}.start_time`
  const parts: string[] = []
  if (range.from) parts.push(`${time} >= DATEADD(day, ${near ? -2 : -1}, ${near ?? range.from})`, `${shiftDay(time, market)} >= ${range.from}`)
  if (range.to) parts.push(`${time} < DATEADD(day, ${near ? 3 : 2}, ${near ?? range.to})`, `${shiftDay(time, market)} <= ${range.to}`)
  return parts.join('\n  AND ')
}

// ── Query A: scheduled blocks in the display window ──────────────────────────
// Verified fast (155 ms). No GPS join — GPS fetched separately via Query C.
/** SCHEDULED_QUERY's rolling window, in days before and after today: LED rows outside it aren't seen. */
export const SCHEDULED_WINDOW = { pastDays: 30, aheadDays: 63 } as const
export const SCHEDULED_QUERY = `
SELECT
    t.truck_number,
    COALESCE(cpm.market,               '') AS market,
    COALESCE(cpm.standard_market_name, '') AS standard_market_name,
    COALESCE(cpm.state,   '') AS state,
    COALESCE(cp.program,  '') AS program,
    COALESCE(cl.client,   '') AS client,  -- internal only; client routes must not pass it on
    COALESCE(cp.job_number, '') AS job_number,
    ${shiftDay('ps.start_time')} AS shift_start,
    ${shiftDay('ps.start_time')} AS shift_end,  -- use start date; end_time bleeds into next day for overnight shifts
    -- Flags, not filters: a deleted program or archived truck is never a
    -- truck for a won hold to follow (lib/ledTruckFollow.ts).
    CAST(COALESCE(cp.is_deleted, 0) AS INT) AS program_deleted,
    CAST(COALESCE(t.is_deleted,  0) AS INT) AS truck_deleted
FROM dbo.program_schedule ps
JOIN dbo.trucks t
    ON  t.truck_uid = ps.truck_uid
LEFT JOIN dbo.client_program_markets cpm
    ON  cpm.client_program_market_uid = ps.client_program_market_uid
LEFT JOIN dbo.client_programs cp
    ON  cp.client_program_uid = ps.client_program_uid
LEFT JOIN dbo.clients cl
    ON  cl.client_uid = cp.client_uid
WHERE ${shiftDayIn({ from: `DATEADD(day, -${SCHEDULED_WINDOW.pastDays}, ${TODAY})`, to: `DATEADD(day, ${SCHEDULED_WINDOW.aheadDays}, ${TODAY})` })}
ORDER BY t.truck_number, ps.start_time
`

// ── Query B: all active trucks ────────────────────────────────────────────────
// Minimal — just what we need to build the truck list.
// Archived trucks (is_deleted = 1 in the LED app) are excluded outright. An
// earlier version also kept archived trucks that had any schedule row in the
// -30/+63 day window, which resurfaced trucks long after they were archived.
export const ALL_TRUCKS_QUERY = `
SELECT truck_number, samsara_id
FROM dbo.trucks t
WHERE COALESCE(t.is_deleted, 0) = 0
ORDER BY truck_number
`

// ── AI chat context: today's per-truck snapshot ───────────────────────────────
// GPS address is omitted here — fetched live from Samsara API in the chat route.
export const CHAT_CONTEXT_QUERY = `
SELECT
    t.truck_number,
    CASE
        WHEN ps.program_schedule_id IS NOT NULL THEN 'SCHEDULED'
        ELSE 'AVAILABLE'
    END AS today_status,
    COALESCE(pm.market,  '') AS market,
    COALESCE(p.program,  '') AS program,
    ${shiftDay('ps.start_time', 'pm')} AS schedule_start,
    ${shiftDay('ps.start_time', 'pm')} AS schedule_end,
    '' AS gps_address,
    COALESCE(lkm.last_known_market, '') AS last_known_market
FROM dbo.trucks t
LEFT JOIN (
    dbo.program_schedule ps
    LEFT JOIN dbo.client_program_markets pm
        ON  pm.client_program_market_uid = ps.client_program_market_uid
)
    ON  ps.truck_uid = t.truck_uid
    AND ${shiftDayIn({ from: todayIn('pm'), to: todayIn('pm') }, 'ps', 'pm', TODAY)}
LEFT JOIN dbo.client_programs p
    ON  p.client_program_uid = ps.client_program_uid
OUTER APPLY (
    SELECT TOP 1 COALESCE(pm_lk.standard_market_name, pm_lk.market) AS last_known_market
    FROM dbo.program_schedule ps_lk
    JOIN dbo.client_program_markets pm_lk
        ON  pm_lk.client_program_market_uid = ps_lk.client_program_market_uid
    WHERE ps_lk.truck_uid = t.truck_uid
      AND ${shiftDayIn({ to: todayIn('pm_lk') }, 'ps_lk', 'pm_lk', TODAY)}
      AND pm_lk.market IS NOT NULL
    ORDER BY ps_lk.start_time DESC
) lkm
WHERE COALESCE(t.is_deleted, 0) = 0
ORDER BY t.truck_number
`

// ── AI chat context: full schedule window (-30 / +60 days) ──────────────────
// One row per truck per scheduled day, so the assistant can answer questions
// about any date in the -30/+60 day window, not just "today". Uses only
// ps.start_time (like SCHEDULED_QUERY) — ps.end_time bleeds into the next
// calendar day for overnight shifts, so casting it directly would make every
// shift look like it runs one day longer than it does. The app groups
// consecutive same-program days into a range after fetching (see
// buildScheduleContext in app/api/chat/route.ts).
export const CHAT_SCHEDULE_WINDOW_QUERY = `
SELECT
    t.truck_number,
    ${shiftDay('ps.start_time')} AS shift_date,
    COALESCE(cpm.market, '') AS market,
    COALESCE(cpm.state,  '') AS state,
    COALESCE(cp.program, '') AS program
FROM dbo.program_schedule ps
JOIN dbo.trucks t
    ON  t.truck_uid = ps.truck_uid
LEFT JOIN dbo.client_program_markets cpm
    ON  cpm.client_program_market_uid = ps.client_program_market_uid
LEFT JOIN dbo.client_programs cp
    ON  cp.client_program_uid = ps.client_program_uid
WHERE COALESCE(t.is_deleted, 0) = 0
  AND ${shiftDayIn({ from: `DATEADD(day, -30, ${TODAY})`, to: `DATEADD(day, 60, ${TODAY})` })}
ORDER BY t.truck_number, ps.start_time
`

// ── Query A2: scheduled blocks WITH market geography ─────────────────────────
// Same rows as SCHEDULED_QUERY, plus the market's centroid when this database
// carries bounding boxes on standard_market_lookup.
//
// Kept separate from SCHEDULED_QUERY on purpose: seven other callers only need
// dates and names, and should not pay for a join or be exposed to a schema
// difference they do not care about.
//
// `withBounds` MUST come from hasMarketBounds(). Referencing bounds columns in
// a database that lacks them is a hard SQL error, not a null.
//
// `windowed` swaps the rolling -30/+63 day window for explicit @windowStart /
// @windowEnd parameters. The rolling window is right for quoting a campaign in
// the next two months, and blind to anything later: a weekly program starting
// next month runs straight past it. The multi-market planner passes its own
// range; every other caller keeps the rolling window.
//
// The windowed form also carries the client name, so the planner can reserve a
// client's trucks by who booked them rather than by matching program names —
// which misses programs named after the product (AT&T's "Alloy Build" is
// booked under 160over90). Only the windowed form joins dbo.clients, so the
// rolling-window query every existing caller runs is unchanged.
export function scheduledWithMarketQuery(withBounds: boolean, windowed = false): string {
  const windowClause = windowed
    ? `WHERE ${shiftDayIn({ from: '@windowStart', to: '@windowEnd' })}`
    : `WHERE ${shiftDayIn({ from: `DATEADD(day, -30, ${TODAY})`, to: `DATEADD(day, 63, ${TODAY})` })}`
  return `
SELECT
    t.truck_number,
    COALESCE(cpm.market,               '') AS market,
    COALESCE(cpm.standard_market_name, '') AS standard_market_name,
    COALESCE(cpm.state,   '') AS state,
    COALESCE(cp.program,  '') AS program,
    COALESCE(cp.job_number, '') AS job_number,${windowed ? `
    COALESCE(cl.client,   '') AS client,` : ''}
    ${shiftDay('ps.start_time')} AS shift_start,
    ${shiftDay('ps.start_time')} AS shift_end${withBounds ? ',' : ''}${withBounds ? `
    CASE WHEN sml.bounds_ne_lat IS NOT NULL AND sml.bounds_sw_lat IS NOT NULL
         THEN (sml.bounds_ne_lat + sml.bounds_sw_lat) / 2.0 END AS market_lat,
    CASE WHEN sml.bounds_ne_lng IS NOT NULL AND sml.bounds_sw_lng IS NOT NULL
         THEN (sml.bounds_ne_lng + sml.bounds_sw_lng) / 2.0 END AS market_lng` : ''}
FROM dbo.program_schedule ps
JOIN dbo.trucks t
    ON  t.truck_uid = ps.truck_uid
LEFT JOIN dbo.client_program_markets cpm
    ON  cpm.client_program_market_uid = ps.client_program_market_uid
LEFT JOIN dbo.client_programs cp
    ON  cp.client_program_uid = ps.client_program_uid${windowed ? `
LEFT JOIN dbo.clients cl
    ON  cl.client_uid = cp.client_uid` : ''}${withBounds ? `
LEFT JOIN dbo.standard_market_lookup sml
    ON  sml.standard_market_uid = cpm.standard_market_uid` : ''}
${windowClause}
ORDER BY t.truck_number, ps.start_time
`
}

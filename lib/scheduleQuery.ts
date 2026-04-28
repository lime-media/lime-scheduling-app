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

// ── Query A: scheduled blocks in the display window ──────────────────────────
// Verified fast (155 ms). No GPS join — GPS fetched separately via Query C.
export const SCHEDULED_QUERY = `
SELECT
    t.truck_number,
    COALESCE(cpm.market,               '') AS market,
    COALESCE(cpm.standard_market_name, '') AS standard_market_name,
    COALESCE(cpm.state,   '') AS state,
    COALESCE(cp.program,  '') AS program,
    CAST(ps.start_time AS DATE) AS shift_start,
    CAST(ps.start_time AS DATE) AS shift_end  -- use start date; end_time bleeds into next day for overnight shifts
FROM dbo.program_schedule ps
JOIN dbo.trucks t
    ON  t.truck_uid = ps.truck_uid
LEFT JOIN dbo.client_program_markets cpm
    ON  cpm.client_program_market_uid = ps.client_program_market_uid
LEFT JOIN dbo.client_programs cp
    ON  cp.client_program_uid = ps.client_program_uid
WHERE CAST(ps.end_time   AS DATE) >= DATEADD(day, -30, CAST(GETDATE() AS DATE))
  AND CAST(ps.start_time AS DATE) <= DATEADD(day,  60, CAST(GETDATE() AS DATE))
ORDER BY t.truck_number, ps.start_time
`

// ── Query B: all active trucks ────────────────────────────────────────────────
// Minimal — just what we need to build the truck list.
export const ALL_TRUCKS_QUERY = `
SELECT truck_number, samsara_id
FROM dbo.trucks t
WHERE COALESCE(t.is_deleted, 0) = 0
   OR EXISTS (
     SELECT 1 FROM dbo.program_schedule ps
     WHERE ps.truck_uid = t.truck_uid
       AND CAST(ps.end_time   AS DATE) >= DATEADD(day, -30, CAST(GETDATE() AS DATE))
       AND CAST(ps.start_time AS DATE) <= DATEADD(day,  60, CAST(GETDATE() AS DATE))
   )
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
    CAST(ps.start_time AS DATE) AS schedule_start,
    CAST(ps.start_time AS DATE) AS schedule_end,
    '' AS gps_address,
    COALESCE(lkm.last_known_market, '') AS last_known_market
FROM dbo.trucks t
LEFT JOIN dbo.program_schedule ps
    ON  ps.truck_uid = t.truck_uid
    AND CAST(GETDATE() AS DATE)
            BETWEEN CAST(ps.start_time AS DATE) AND CAST(ps.end_time AS DATE)
LEFT JOIN dbo.client_programs p
    ON  p.client_program_uid = ps.client_program_uid
LEFT JOIN dbo.client_program_markets pm
    ON  pm.client_program_market_uid = ps.client_program_market_uid
OUTER APPLY (
    SELECT TOP 1 pm_lk.market AS last_known_market
    FROM dbo.program_schedule ps_lk
    JOIN dbo.client_program_markets pm_lk
        ON  pm_lk.client_program_market_uid = ps_lk.client_program_market_uid
    WHERE ps_lk.truck_uid = t.truck_uid
      AND CAST(ps_lk.start_time AS DATE) <= CAST(GETDATE() AS DATE)
      AND pm_lk.market IS NOT NULL
    ORDER BY ps_lk.start_time DESC
) lkm
WHERE COALESCE(t.is_deleted, 0) = 0
ORDER BY t.truck_number
`

export const SCHEDULE_SUMMARY_QUERY = `
SELECT
    t.truck_number,
    COUNT(DISTINCT ps.client_program_uid) AS active_programs,
    MIN(CAST(ps.start_time AS DATE))      AS next_schedule_start,
    MAX(CAST(ps.end_time   AS DATE))      AS schedule_end
FROM dbo.trucks t
LEFT JOIN dbo.program_schedule ps
    ON  t.truck_uid = ps.truck_uid
    AND CAST(ps.end_time AS DATE) >= CAST(GETDATE() AS DATE)
WHERE COALESCE(t.is_deleted, 0) = 0
GROUP BY t.truck_number
ORDER BY t.truck_number
`

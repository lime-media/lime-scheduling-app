-- Last activity: count logins, and not the Salesforce service account.
-- Usage log: bring in the history recorded before it existed.
--
-- The first backfill (20261005120000) only counted actions (holds, expiry
-- changes, chats), so people who logged in and only looked or quoted showed
-- an old date or "Never". Each successful login is a consumed row in
-- app_login_otps; use the latest one where it is more recent. The Salesforce
-- integration's service account is not a person: clear it.
--
-- Safe to re-run: only ever moves a date forward, or clears the service account.

UPDATE u SET last_active_at = l.last_login
FROM [dbo].[app_users] u
CROSS APPLY (SELECT MAX(consumed_at) AS last_login FROM [dbo].[app_login_otps] o WHERE o.user_id = u.id) l
WHERE l.last_login IS NOT NULL
  AND (u.last_active_at IS NULL OR l.last_login > u.last_active_at)
  AND u.email <> 'sfdc-integration@lime-media.com';

UPDATE [dbo].[app_users] SET last_active_at = NULL WHERE email = 'sfdc-integration@lime-media.com';

-- ── Usage log: bring in history recorded before it existed ───────────────────
-- Everything already on record goes into app_usage_log, so the Usage page has
-- one history: staff AI chat (question, answer, real response time), client
-- portal AI chat, and holds placed from the quote tools (one row per booking,
-- with its total). Past quote RUNS were never recorded anywhere, so they
-- cannot be recovered; cancelled holds were deleted, so they are not here.
-- Fixed ids (derived from the source row): re-running adds nothing twice.

-- Staff AI chat: each question, its answer, and how long the answer took.
INSERT INTO [dbo].[app_usage_log] (id, created_at, actor_type, actor_id, actor_name, tool, inputs, result, outcome, status, latency_ms)
SELECT 'c' + REPLACE(m.id, '-', ''), m.created_at, 'app_user', cv.user_id, COALESCE(u.name, 'Former user'), 'ai_chat_staff',
       (SELECT LEFT(m.content, 500) AS message, 'chat history' AS backfilled_from FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
       (SELECT LEFT(a.content, 300) AS reply FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
       CASE WHEN a.content IS NULL THEN 'error' ELSE 'success' END, 200,
       CASE WHEN a.created_at IS NULL THEN 0 ELSE DATEDIFF(millisecond, m.created_at, a.created_at) END
FROM [dbo].[chat_messages] m
JOIN [dbo].[chat_conversations] cv ON cv.id = m.conversation_id
LEFT JOIN [dbo].[app_users] u ON u.id = cv.user_id
OUTER APPLY (SELECT TOP 1 x.content, x.created_at FROM [dbo].[chat_messages] x
             WHERE x.conversation_id = m.conversation_id AND x.role = 'assistant' AND x.created_at >= m.created_at
             ORDER BY x.created_at) a
WHERE m.role = 'user'
  AND NOT EXISTS (SELECT 1 FROM [dbo].[app_usage_log] g WHERE g.id = 'c' + REPLACE(m.id, '-', ''));

-- Client portal AI chat — in full: the usage log becomes its only record
-- (the client chat no longer writes app_client_ai_questions).
IF OBJECT_ID('dbo.app_client_ai_questions', 'U') IS NOT NULL
INSERT INTO [dbo].[app_usage_log] (id, created_at, actor_type, actor_id, actor_name, tool, inputs, result, outcome, status, latency_ms)
SELECT 'q' + q.id, q.asked_at, 'client_user', q.client_user_id,
       COALESCE(c.company_name + ' (' + c.username + ')', NULLIF(q.company_name, ''), 'Former client'), 'ai_chat_client',
       (SELECT q.question AS message, 'chat history' AS backfilled_from FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
       (SELECT q.answer AS reply FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
       'success', 200, 0
FROM [dbo].[app_client_ai_questions] q
LEFT JOIN [dbo].[app_client_users] c ON c.id = q.client_user_id
WHERE NOT EXISTS (SELECT 1 FROM [dbo].[app_usage_log] g WHERE g.id = 'q' + q.id);

-- MCP tool calls — the MCP server's reports now go straight to the usage log
-- (POST /api/v1/internal/query-log); the earlier ones come over here.
IF OBJECT_ID('dbo.mcp_query_log', 'U') IS NOT NULL
INSERT INTO [dbo].[app_usage_log] (id, created_at, actor_type, actor_id, actor_name, tool, inputs, result, outcome, status, latency_ms)
SELECT 'm' + l.id, l.created_at,
       CASE WHEN l.user_type = 'client_user' THEN 'client_user' ELSE 'app_user' END,
       COALESCE(l.user_id, 'unknown'),
       COALESCE(CASE WHEN l.user_type = 'client_user' THEN c.company_name + ' (' + c.username + ')' ELSE u.name END, l.user_id, 'Unknown'),
       LEFT('mcp_' + l.tool_name, 100), l.request_params, l.response_summary,
       CASE l.outcome WHEN 'success' THEN 'success' WHEN 'no_availability' THEN 'not_feasible' ELSE 'error' END,
       CASE l.outcome WHEN 'success' THEN 200 WHEN 'no_availability' THEN 409 ELSE 500 END,
       l.latency_ms
FROM [dbo].[mcp_query_log] l
LEFT JOIN [dbo].[app_users] u ON u.id = l.user_id
LEFT JOIN [dbo].[app_client_users] c ON c.id = l.user_id
WHERE NOT EXISTS (SELECT 1 FROM [dbo].[app_usage_log] g WHERE g.id = 'm' + l.id);

-- Holds placed from the quote tools: one row per booking. A multi-market
-- booking's holds share a request prefix (mm_<request>_<line>) and store each
-- market's total; a Classic or client booking stores the campaign total on
-- every hold.
WITH h AS (
    SELECT h.*,
           CASE WHEN h.campaign_group_id LIKE 'mm%'
                THEN LEFT(h.campaign_group_id, LEN(h.campaign_group_id) - CHARINDEX('_', REVERSE(h.campaign_group_id)))
                ELSE COALESCE(h.campaign_group_id, h.id) END AS run_key
    FROM [dbo].[app_holds] h
    WHERE h.source IN ('INTERNAL', 'CLIENT') AND h.status <> 'ATT_SOFT'
      AND h.origination IN ('frontend', 'client-view', 'quote_only')
      AND (h.campaign_group_id IS NOT NULL OR h.source = 'CLIENT')
),
lines AS (SELECT run_key, MAX(quoted_total) AS line_total FROM h GROUP BY run_key, COALESCE(campaign_group_id, id)),
totals AS (SELECT run_key, SUM(line_total) AS total FROM lines GROUP BY run_key),
runs AS (
    SELECT run_key, MIN(created_at) AS at, MIN(source) AS source, MIN(created_by) AS created_by, MIN(client_user_id) AS client_user_id,
           MIN(CASE WHEN campaign_group_id LIKE 'mm%' THEN 'hold_multi' WHEN source = 'CLIENT' THEN 'hold_client' ELSE 'hold_classic' END) AS tool,
           MIN(client_name) AS account, COUNT(DISTINCT market) AS markets, MIN(market) AS market,
           MIN(start_date) AS s, MAX(end_date) AS e, COUNT(DISTINCT truck_number) AS trucks, COUNT(*) AS holds,
           MAX(CASE WHEN origination = 'quote_only' THEN 1 ELSE 0 END) AS quote_only
    FROM h GROUP BY run_key
)
INSERT INTO [dbo].[app_usage_log] (id, created_at, actor_type, actor_id, actor_name, tool, inputs, result, outcome, status, latency_ms)
SELECT 'h' + CONVERT(NVARCHAR(32), HASHBYTES('MD5', r.run_key), 2), r.at,
       CASE WHEN r.source = 'CLIENT' THEN 'client_user' ELSE 'app_user' END,
       CASE WHEN r.source = 'CLIENT' THEN COALESCE(r.client_user_id, r.created_by) ELSE r.created_by END,
       COALESCE(CASE WHEN r.source = 'CLIENT' THEN c.company_name + ' (' + c.username + ')' ELSE u.name END, 'Former user'),
       r.tool,
       (SELECT CASE WHEN r.markets > 1 THEN CAST(r.markets AS NVARCHAR(10)) + ' markets' ELSE r.market END AS market,
               CONVERT(CHAR(10), r.s, 23) AS start_date, CONVERT(CHAR(10), r.e, 23) AS end_date,
               r.trucks AS truck_count, r.account AS sfdc_account_name, 'holds' AS backfilled_from
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
       (SELECT CAST(t.total AS DECIMAL(14, 2)) AS total, r.holds AS holds, CASE WHEN r.quote_only = 1 THEN 'quote only, nothing reserved' END AS note
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
       'success', 200, 0
FROM runs r
JOIN totals t ON t.run_key = r.run_key
LEFT JOIN [dbo].[app_users] u ON u.id = r.created_by
LEFT JOIN [dbo].[app_client_users] c ON c.id = r.client_user_id
WHERE NOT EXISTS (SELECT 1 FROM [dbo].[app_usage_log] g WHERE g.id = 'h' + CONVERT(NVARCHAR(32), HASHBYTES('MD5', r.run_key), 2));

-- ── Verify ───────────────────────────────────────────────────────────────────
-- Expect: 0, 0, then about 286 staff chats, 42 client chats, 20 bookings and
-- 25 MCP calls (more if used since).
SELECT
    (SELECT COUNT(*) FROM [dbo].[app_users] u
       CROSS APPLY (SELECT MAX(consumed_at) AS last_login FROM [dbo].[app_login_otps] o WHERE o.user_id = u.id) l
       WHERE l.last_login > COALESCE(u.last_active_at, '1900-01-01')
         AND u.email <> 'sfdc-integration@lime-media.com')                                   AS older_than_last_login,
    (SELECT COUNT(*) FROM [dbo].[app_users] WHERE email = 'sfdc-integration@lime-media.com'
       AND last_active_at IS NOT NULL)                                                      AS service_account_active,
    (SELECT COUNT(*) FROM [dbo].[app_usage_log] WHERE tool = 'ai_chat_staff')                AS usage_staff_chat,
    (SELECT COUNT(*) FROM [dbo].[app_usage_log] WHERE tool = 'ai_chat_client')               AS usage_client_chat,
    (SELECT COUNT(*) FROM [dbo].[app_usage_log] WHERE tool LIKE 'hold[_]%')                  AS usage_holds,
    (SELECT COUNT(*) FROM [dbo].[app_usage_log] WHERE tool LIKE 'mcp[_]%')                   AS usage_mcp;

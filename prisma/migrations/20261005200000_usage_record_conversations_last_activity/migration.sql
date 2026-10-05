-- One record of tool use; conversations as their own store; last activity
-- from logins. Run BEFORE deploying PR #102 (its code writes the new
-- columns). Safe to re-run: every step is guarded or skips rows already done.
--
-- Design:
--   app_usage_log        who used which tool, when, with what result — app and
--                        MCP alike. Metadata only, with reportable columns.
--   chat_conversations / the TEXT of AI chats, staff and client, marked by
--   chat_messages        actor_type; its own access and deletion. A chat's
--                        usage row links here by conversation_id.
--   app_audit_logs       what changed on a reservation (unchanged).
-- mcp_query_log and app_client_ai_questions are copied in here and no longer
-- used by the code. Dropping them is a separate, explicit step.
-- No GO separators: works in sqlcmd, SSMS, Azure Data Studio or the portal.

-- ── 1. Last activity: count logins; the Salesforce service account is not a person ──
UPDATE u SET last_active_at = l.last_login
FROM [dbo].[app_users] u
CROSS APPLY (SELECT MAX(consumed_at) AS last_login FROM [dbo].[app_login_otps] o WHERE o.user_id = u.id) l
WHERE l.last_login IS NOT NULL
  AND (u.last_active_at IS NULL OR l.last_login > u.last_active_at)
  AND u.email <> 'sfdc-integration@lime-media.com';

UPDATE [dbo].[app_users] SET last_active_at = NULL WHERE email = 'sfdc-integration@lime-media.com';

-- ── 2. New columns ─────────────────────────────────────────────────────────────
IF COL_LENGTH('dbo.chat_conversations', 'actor_type') IS NULL
    ALTER TABLE [dbo].[chat_conversations] ADD [actor_type] NVARCHAR(20) NOT NULL
        CONSTRAINT [DF_chat_conversations_actor_type] DEFAULT 'app_user';

IF COL_LENGTH('dbo.app_usage_log', 'market') IS NULL          ALTER TABLE [dbo].[app_usage_log] ADD [market] NVARCHAR(200) NULL;
IF COL_LENGTH('dbo.app_usage_log', 'account') IS NULL         ALTER TABLE [dbo].[app_usage_log] ADD [account] NVARCHAR(255) NULL;
IF COL_LENGTH('dbo.app_usage_log', 'total') IS NULL           ALTER TABLE [dbo].[app_usage_log] ADD [total] DECIMAL(14, 2) NULL;
IF COL_LENGTH('dbo.app_usage_log', 'holds') IS NULL           ALTER TABLE [dbo].[app_usage_log] ADD [holds] INT NULL;
IF COL_LENGTH('dbo.app_usage_log', 'conversation_id') IS NULL ALTER TABLE [dbo].[app_usage_log] ADD [conversation_id] NVARCHAR(64) NULL;

EXEC(N'
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = ''IX_chat_conversations_owner'')
    CREATE NONCLUSTERED INDEX [IX_chat_conversations_owner] ON [dbo].[chat_conversations] ([user_id], [actor_type], [updated_at]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = ''IX_app_usage_log_conversation'')
    CREATE NONCLUSTERED INDEX [IX_app_usage_log_conversation] ON [dbo].[app_usage_log] ([conversation_id]);
');

-- ── 3. Client chats into the conversation store ───────────────────────────────
-- Their questions were stored one by one; each client's questions on a given
-- day become one conversation (the portal kept no conversation of its own).
EXEC(N'
IF OBJECT_ID(''dbo.app_client_ai_questions'', ''U'') IS NOT NULL
BEGIN
    INSERT INTO [dbo].[chat_conversations] (id, title, user_id, actor_type, created_at, updated_at)
    SELECT ''cc'' + CONVERT(NVARCHAR(32), HASHBYTES(''MD5'', q.client_user_id + ''|'' + CONVERT(CHAR(10), CAST(q.asked_at AS DATE), 23)), 2),
           LEFT(MIN(q.question), 60), q.client_user_id, ''client_user'', MIN(q.asked_at), MAX(q.asked_at)
    FROM [dbo].[app_client_ai_questions] q
    GROUP BY q.client_user_id, CAST(q.asked_at AS DATE)
    HAVING NOT EXISTS (SELECT 1 FROM [dbo].[chat_conversations] c
                       WHERE c.id = ''cc'' + CONVERT(NVARCHAR(32), HASHBYTES(''MD5'', q.client_user_id + ''|'' + CONVERT(CHAR(10), CAST(q.asked_at AS DATE), 23)), 2));

    INSERT INTO [dbo].[chat_messages] (id, conversation_id, role, content, created_at)
    SELECT ''q'' + q.id + ''u'',
           ''cc'' + CONVERT(NVARCHAR(32), HASHBYTES(''MD5'', q.client_user_id + ''|'' + CONVERT(CHAR(10), CAST(q.asked_at AS DATE), 23)), 2),
           ''user'', q.question, q.asked_at
    FROM [dbo].[app_client_ai_questions] q
    WHERE NOT EXISTS (SELECT 1 FROM [dbo].[chat_messages] m WHERE m.id = ''q'' + q.id + ''u'');

    INSERT INTO [dbo].[chat_messages] (id, conversation_id, role, content, created_at)
    SELECT ''q'' + q.id + ''a'',
           ''cc'' + CONVERT(NVARCHAR(32), HASHBYTES(''MD5'', q.client_user_id + ''|'' + CONVERT(CHAR(10), CAST(q.asked_at AS DATE), 23)), 2),
           ''assistant'', q.answer, DATEADD(MILLISECOND, 1, q.asked_at)
    FROM [dbo].[app_client_ai_questions] q
    WHERE q.answer <> '''' AND NOT EXISTS (SELECT 1 FROM [dbo].[chat_messages] m WHERE m.id = ''q'' + q.id + ''a'');
END
');

-- ── 4. History into the usage log ─────────────────────────────────────────────
-- Fixed ids derived from the source rows: re-running adds nothing twice. Past
-- quote RUNS were never recorded anywhere and cannot be recovered; cancelled
-- holds were deleted at the time.

-- Staff AI chat: preview of each question and answer, the real response
-- time, and a link to its conversation (where the full text lives).
EXEC(N'
INSERT INTO [dbo].[app_usage_log] (id, created_at, actor_type, actor_id, actor_name, tool, inputs, result, outcome, status, latency_ms, conversation_id)
SELECT ''c'' + REPLACE(m.id, ''-'', ''''), m.created_at, ''app_user'', cv.user_id, COALESCE(u.name, ''Former user''), ''ai_chat_staff'',
       (SELECT LEFT(m.content, 500) AS message, ''chat history'' AS backfilled_from FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
       (SELECT LEFT(a.content, 300) AS reply, cv.id AS conversation_id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
       CASE WHEN a.content IS NULL THEN ''error'' ELSE ''success'' END, 200,
       CASE WHEN a.created_at IS NULL THEN 0 ELSE DATEDIFF(MILLISECOND, m.created_at, a.created_at) END,
       cv.id
FROM [dbo].[chat_messages] m
JOIN [dbo].[chat_conversations] cv ON cv.id = m.conversation_id AND cv.actor_type = ''app_user''
LEFT JOIN [dbo].[app_users] u ON u.id = cv.user_id
OUTER APPLY (SELECT TOP 1 x.content, x.created_at FROM [dbo].[chat_messages] x
             WHERE x.conversation_id = m.conversation_id AND x.role = ''assistant'' AND x.created_at >= m.created_at
             ORDER BY x.created_at) a
WHERE m.role = ''user''
  AND NOT EXISTS (SELECT 1 FROM [dbo].[app_usage_log] g WHERE g.id = ''c'' + REPLACE(m.id, ''-'', ''''));
');

-- Client portal AI chat: preview and a link to its conversation (step 3).
EXEC(N'
IF OBJECT_ID(''dbo.app_client_ai_questions'', ''U'') IS NOT NULL
INSERT INTO [dbo].[app_usage_log] (id, created_at, actor_type, actor_id, actor_name, tool, inputs, result, outcome, status, latency_ms, account, conversation_id)
SELECT ''q'' + q.id, q.asked_at, ''client_user'', q.client_user_id,
       COALESCE(c.company_name + '' ('' + c.username + '')'', NULLIF(q.company_name, ''''), ''Former client''), ''ai_chat_client'',
       (SELECT LEFT(q.question, 500) AS message, ''chat history'' AS backfilled_from FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
       (SELECT LEFT(q.answer, 300) AS reply,
               ''cc'' + CONVERT(NVARCHAR(32), HASHBYTES(''MD5'', q.client_user_id + ''|'' + CONVERT(CHAR(10), CAST(q.asked_at AS DATE), 23)), 2) AS conversation_id
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
       ''success'', 200, 0,
       COALESCE(c.company_name + '' ('' + c.username + '')'', NULLIF(q.company_name, '''')),
       ''cc'' + CONVERT(NVARCHAR(32), HASHBYTES(''MD5'', q.client_user_id + ''|'' + CONVERT(CHAR(10), CAST(q.asked_at AS DATE), 23)), 2)
FROM [dbo].[app_client_ai_questions] q
LEFT JOIN [dbo].[app_client_users] c ON c.id = q.client_user_id
WHERE NOT EXISTS (SELECT 1 FROM [dbo].[app_usage_log] g WHERE g.id = ''q'' + q.id);
');

-- MCP tool calls (the MCP server's reports now go straight to the usage log).
EXEC(N'
IF OBJECT_ID(''dbo.mcp_query_log'', ''U'') IS NOT NULL
INSERT INTO [dbo].[app_usage_log] (id, created_at, actor_type, actor_id, actor_name, tool, inputs, result, outcome, status, latency_ms)
SELECT ''m'' + l.id, l.created_at,
       CASE WHEN l.user_type = ''client_user'' THEN ''client_user'' ELSE ''app_user'' END,
       COALESCE(l.user_id, ''unknown''),
       COALESCE(CASE WHEN l.user_type = ''client_user'' THEN c.company_name + '' ('' + c.username + '')'' ELSE u.name END, l.user_id, ''Unknown''),
       LEFT(''mcp_'' + l.tool_name, 100), l.request_params, l.response_summary,
       CASE l.outcome WHEN ''success'' THEN ''success'' WHEN ''no_availability'' THEN ''not_feasible'' ELSE ''error'' END,
       CASE l.outcome WHEN ''success'' THEN 200 WHEN ''no_availability'' THEN 409 ELSE 500 END,
       l.latency_ms
FROM [dbo].[mcp_query_log] l
LEFT JOIN [dbo].[app_users] u ON u.id = l.user_id
LEFT JOIN [dbo].[app_client_users] c ON c.id = l.user_id
WHERE NOT EXISTS (SELECT 1 FROM [dbo].[app_usage_log] g WHERE g.id = ''m'' + l.id);
');

-- Holds booked from the quote tools: one row per booking. A multi-market
-- booking's holds share a request prefix (mm_<request>_<line>) and store each
-- market's total; a Classic or client booking stores the campaign total on
-- every hold.
EXEC(N'
WITH h AS (
    SELECT h.*,
           CASE WHEN h.campaign_group_id LIKE ''mm%''
                THEN LEFT(h.campaign_group_id, LEN(h.campaign_group_id) - CHARINDEX(''_'', REVERSE(h.campaign_group_id)))
                ELSE COALESCE(h.campaign_group_id, h.id) END AS run_key
    FROM [dbo].[app_holds] h
    WHERE h.source IN (''INTERNAL'', ''CLIENT'') AND h.status <> ''ATT_SOFT''
      AND h.origination IN (''frontend'', ''client-view'', ''quote_only'')
      AND (h.campaign_group_id IS NOT NULL OR h.source = ''CLIENT'')
),
lines AS (SELECT run_key, MAX(quoted_total) AS line_total FROM h GROUP BY run_key, COALESCE(campaign_group_id, id)),
totals AS (SELECT run_key, SUM(line_total) AS total FROM lines GROUP BY run_key),
runs AS (
    SELECT run_key, MIN(created_at) AS at, MIN(source) AS source, MIN(created_by) AS created_by, MIN(client_user_id) AS client_user_id,
           MIN(CASE WHEN campaign_group_id LIKE ''mm%'' THEN ''hold_multi'' WHEN source = ''CLIENT'' THEN ''hold_client'' ELSE ''hold_classic'' END) AS tool,
           MIN(client_name) AS account, COUNT(DISTINCT market) AS markets, MIN(market) AS market,
           MIN(start_date) AS s, MAX(end_date) AS e, COUNT(DISTINCT truck_number) AS trucks, COUNT(*) AS holds,
           MAX(CASE WHEN origination = ''quote_only'' THEN 1 ELSE 0 END) AS quote_only
    FROM h GROUP BY run_key
)
INSERT INTO [dbo].[app_usage_log] (id, created_at, actor_type, actor_id, actor_name, tool, inputs, result, outcome, status, latency_ms, market, account, total, holds)
SELECT ''h'' + CONVERT(NVARCHAR(32), HASHBYTES(''MD5'', r.run_key), 2), r.at,
       CASE WHEN r.source = ''CLIENT'' THEN ''client_user'' ELSE ''app_user'' END,
       CASE WHEN r.source = ''CLIENT'' THEN COALESCE(r.client_user_id, r.created_by) ELSE r.created_by END,
       COALESCE(CASE WHEN r.source = ''CLIENT'' THEN c.company_name + '' ('' + c.username + '')'' ELSE u.name END, ''Former user''),
       r.tool,
       (SELECT CASE WHEN r.markets > 1 THEN CAST(r.markets AS NVARCHAR(10)) + '' markets'' ELSE r.market END AS market,
               CONVERT(CHAR(10), r.s, 23) AS start_date, CONVERT(CHAR(10), r.e, 23) AS end_date,
               r.trucks AS truck_count, r.account AS sfdc_account_name, ''holds'' AS backfilled_from
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
       (SELECT CAST(t.total AS DECIMAL(14, 2)) AS total, r.holds AS holds, CASE WHEN r.quote_only = 1 THEN ''quote only, nothing reserved'' END AS note
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
       ''success'', 200, 0,
       LEFT(CASE WHEN r.markets > 1 THEN CAST(r.markets AS NVARCHAR(10)) + '' markets'' ELSE r.market END, 200),
       LEFT(r.account, 255), CAST(t.total AS DECIMAL(14, 2)), r.holds
FROM runs r
JOIN totals t ON t.run_key = r.run_key
LEFT JOIN [dbo].[app_users] u ON u.id = r.created_by
LEFT JOIN [dbo].[app_client_users] c ON c.id = r.client_user_id
WHERE NOT EXISTS (SELECT 1 FROM [dbo].[app_usage_log] g WHERE g.id = ''h'' + CONVERT(NVARCHAR(32), HASHBYTES(''MD5'', r.run_key), 2));
');

-- ── 5. Reportable columns for every row (including runs logged since PR #100) ──
EXEC(N'
UPDATE g SET
    market = LEFT(COALESCE(g.market, JSON_VALUE(g.inputs, ''$.market''), JSON_VALUE(g.inputs, ''$.campaign_city''),
                           CASE WHEN ISJSON(g.inputs) = 1 AND JSON_QUERY(g.inputs, ''$.rows'') IS NOT NULL
                                THEN CAST(COALESCE(TRY_CAST(JSON_VALUE(g.inputs, ''$.rows.count'') AS INT),
                                                   (SELECT COUNT(*) FROM OPENJSON(g.inputs, ''$.rows''))) AS NVARCHAR(10)) + '' markets'' END,
                           JSON_VALUE(g.result, ''$.market'')), 200),
    account = LEFT(COALESCE(g.account, JSON_VALUE(g.inputs, ''$.sfdc_account_name''), JSON_VALUE(g.inputs, ''$.sfdcAccountName''),
                            CASE WHEN g.actor_type = ''client_user'' THEN g.actor_name END), 255),
    total = COALESCE(g.total, CAST(TRY_CAST(COALESCE(JSON_VALUE(g.result, ''$.total''), JSON_VALUE(g.result, ''$.grand_total''),
                                                       JSON_VALUE(g.result, ''$.best_total''), JSON_VALUE(g.result, ''$.good_total'')) AS FLOAT) AS DECIMAL(14, 2))),
    holds = COALESCE(g.holds, TRY_CAST(COALESCE(JSON_VALUE(g.result, ''$.holds''), JSON_VALUE(g.result, ''$.hold_count'')) AS INT)),
    conversation_id = COALESCE(g.conversation_id, JSON_VALUE(g.result, ''$.conversation_id''))
FROM [dbo].[app_usage_log] g
WHERE ISJSON(COALESCE(g.inputs, ''{}'')) = 1 AND ISJSON(COALESCE(g.result, ''{}'')) = 1;
');

-- ── 6. Verify ─────────────────────────────────────────────────────────────────
-- Expect: older_than_last_login 0, service_account_active 0; usage rows of
-- about 286 staff chats, 42 client chats, 20 bookings and 25 MCP calls (more if
-- used since); client_conversations 4 and client_messages 84 (production,
-- dry run); chats_unlinked 0.
EXEC(N'
SELECT
    (SELECT COUNT(*) FROM [dbo].[app_users] u
       CROSS APPLY (SELECT MAX(consumed_at) AS last_login FROM [dbo].[app_login_otps] o WHERE o.user_id = u.id) l
       WHERE l.last_login > COALESCE(u.last_active_at, ''1900-01-01'')
         AND u.email <> ''sfdc-integration@lime-media.com'')                                           AS older_than_last_login,
    (SELECT COUNT(*) FROM [dbo].[app_users] WHERE email = ''sfdc-integration@lime-media.com'' AND last_active_at IS NOT NULL) AS service_account_active,
    (SELECT COUNT(*) FROM [dbo].[app_usage_log] WHERE tool = ''ai_chat_staff'')                       AS usage_staff_chat,
    (SELECT COUNT(*) FROM [dbo].[app_usage_log] WHERE tool = ''ai_chat_client'')                      AS usage_client_chat,
    (SELECT COUNT(*) FROM [dbo].[app_usage_log] WHERE tool LIKE ''hold[_]%'')                         AS usage_holds,
    (SELECT COUNT(*) FROM [dbo].[app_usage_log] WHERE tool LIKE ''mcp[_]%'')                          AS usage_mcp,
    (SELECT COUNT(*) FROM [dbo].[chat_conversations] WHERE actor_type = ''client_user'')              AS client_conversations,
    (SELECT COUNT(*) FROM [dbo].[chat_messages] m JOIN [dbo].[chat_conversations] c ON c.id = m.conversation_id
       WHERE c.actor_type = ''client_user'')                                                          AS client_messages,
    (SELECT COUNT(*) FROM [dbo].[app_usage_log] WHERE tool LIKE ''ai[_]chat[_]%'' AND conversation_id IS NULL) AS chats_unlinked
');

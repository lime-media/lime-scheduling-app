-- Usage logging and last-activity dates.
--
--   dbo.app_usage_log                 every quote and AI run (lib/usageLog.ts)
--   dbo.app_users.last_active_at      last time a staff user did anything
--   dbo.app_client_users.last_active_at  last time a client did anything
--   dbo.mcp_tokens.last_used_at       last time an MCP token was used
--
-- Safe to re-run: every statement is guarded. Run BEFORE deploying the code
-- (the Users page reads the new columns). Backfills the dates from history
-- that already exists, only where they are still empty.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'app_usage_log' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    CREATE TABLE [dbo].[app_usage_log] (
        [id]         NVARCHAR(36)   NOT NULL,
        [created_at] DATETIME2      NOT NULL CONSTRAINT [DF_app_usage_log_created_at] DEFAULT SYSUTCDATETIME(),
        [actor_type] NVARCHAR(20)   NOT NULL,
        [actor_id]   NVARCHAR(255)  NOT NULL,
        [actor_name] NVARCHAR(1000) NOT NULL CONSTRAINT [DF_app_usage_log_actor_name] DEFAULT '',
        [tool]       NVARCHAR(100)  NOT NULL,
        [inputs]     NVARCHAR(MAX)  NULL,
        [result]     NVARCHAR(MAX)  NULL,
        [outcome]    NVARCHAR(20)   NOT NULL,
        [status]     INT            NOT NULL,
        [latency_ms] INT            NOT NULL,
        CONSTRAINT [PK_app_usage_log] PRIMARY KEY CLUSTERED ([id])
    );
    CREATE NONCLUSTERED INDEX [IX_app_usage_log_created_at] ON [dbo].[app_usage_log] ([created_at]);
    CREATE NONCLUSTERED INDEX [IX_app_usage_log_actor] ON [dbo].[app_usage_log] ([actor_id], [created_at]);
    CREATE NONCLUSTERED INDEX [IX_app_usage_log_tool] ON [dbo].[app_usage_log] ([tool], [created_at]);
END;

IF COL_LENGTH('dbo.app_users', 'last_active_at') IS NULL
    ALTER TABLE [dbo].[app_users] ADD [last_active_at] DATETIME2 NULL;
IF COL_LENGTH('dbo.app_client_users', 'last_active_at') IS NULL
    ALTER TABLE [dbo].[app_client_users] ADD [last_active_at] DATETIME2 NULL;
IF COL_LENGTH('dbo.mcp_tokens', 'last_used_at') IS NULL
    ALTER TABLE [dbo].[mcp_tokens] ADD [last_used_at] DATETIME2 NULL;

-- ── Backfill from existing history (only empty dates) ────────────────────────
-- Run through EXEC so the new columns resolve at run time: no GO separator
-- needed, so this file works in sqlcmd, SSMS, Azure Data Studio or the portal.
-- Staff: actions a person takes (not the sweep's warnings, expiries or the
-- AT&T sync's deletes, which are written under the hold owner's id), chat
-- conversations, and holds they placed themselves.
EXEC(N'
UPDATE u SET last_active_at = x.last_at
FROM [dbo].[app_users] u
CROSS APPLY (
    SELECT MAX(t) AS last_at FROM (
        SELECT MAX(created_at) AS t FROM [dbo].[app_audit_logs] WHERE user_id = u.id
            AND action IN (''UPDATE_HOLD_EXPIRATION'', ''CANCEL_HOLD'', ''SWAP_HOLD_TRUCK'', ''CREATE_HOLD'', ''REINSTATE_HOLD'',
                           ''APPROVE_HOLD_EXTENSION'', ''DENY_HOLD_EXTENSION'', ''RELEASE_ATT_SOFT'', ''UNDO_RELEASE_ATT_SOFT'', ''DISMISS_ATT_SOFT_CONFLICT'')
        UNION ALL SELECT MAX(updated_at) FROM [dbo].[chat_conversations] WHERE user_id = u.id
        UNION ALL SELECT MAX(created_at) FROM [dbo].[app_holds] WHERE created_by = u.id
            AND source = ''INTERNAL'' AND status <> ''ATT_SOFT'' AND COALESCE(origination, '''') <> ''att_soft_release''
    ) s
) x
WHERE u.last_active_at IS NULL AND x.last_at IS NOT NULL;
');

-- Clients: portal AI questions, holds they placed, MCP calls.
EXEC(N'
UPDATE c SET last_active_at = x.last_at
FROM [dbo].[app_client_users] c
CROSS APPLY (
    SELECT MAX(t) AS last_at FROM (
        SELECT MAX(asked_at) AS t FROM [dbo].[app_client_ai_questions] WHERE client_user_id = c.id
        UNION ALL SELECT MAX(created_at) FROM [dbo].[app_holds]        WHERE client_user_id = c.id
        UNION ALL SELECT MAX(created_at) FROM [dbo].[mcp_query_log]    WHERE user_id = c.id
    ) s
) x
WHERE c.last_active_at IS NULL AND x.last_at IS NOT NULL;
');

-- MCP tokens: their own log entries.
EXEC(N'
UPDATE t SET last_used_at = x.last_at
FROM [dbo].[mcp_tokens] t
CROSS APPLY (SELECT MAX(created_at) AS last_at FROM [dbo].[mcp_query_log] WHERE token_id = t.id) x
WHERE t.last_used_at IS NULL AND x.last_at IS NOT NULL;
');


-- ── Verify ───────────────────────────────────────────────────────────────────
-- Expect: usage_log_table 1, the three columns 1 each, and some backfilled rows.
-- Through EXEC: it reads the columns this script just added.
EXEC(N'
SELECT
    (SELECT COUNT(*) FROM sys.tables WHERE name = ''app_usage_log'')                    AS usage_log_table,
    CASE WHEN COL_LENGTH(''dbo.app_users'', ''last_active_at'') IS NULL THEN 0 ELSE 1 END       AS users_last_active,
    CASE WHEN COL_LENGTH(''dbo.app_client_users'', ''last_active_at'') IS NULL THEN 0 ELSE 1 END AS clients_last_active,
    CASE WHEN COL_LENGTH(''dbo.mcp_tokens'', ''last_used_at'') IS NULL THEN 0 ELSE 1 END         AS tokens_last_used,
    (SELECT COUNT(*) FROM [dbo].[app_users]        WHERE last_active_at IS NOT NULL)    AS users_backfilled,
    (SELECT COUNT(*) FROM [dbo].[app_client_users] WHERE last_active_at IS NOT NULL)    AS clients_backfilled,
    (SELECT COUNT(*) FROM [dbo].[mcp_tokens]       WHERE last_used_at IS NOT NULL)      AS tokens_backfilled
');

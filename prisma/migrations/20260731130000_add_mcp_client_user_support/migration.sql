-- ============================================================
-- MCP tokens/query log: support both app_users and app_client_users
-- Backfilled migration: already applied to the live database
-- (added by hand alongside commit e14d4c1, "Merge pull request #4
-- from lime-media/feature/mcp-v2-client-users: MCP V2: extend
-- tokens to support client users", 2026-07-31) but never captured
-- under prisma/migrations — previously lived only as the
-- standalone prisma/mcp-v2-client-users-migration.sql script.
-- All statements are guarded and no-op if already applied.
--
-- Depends on 20260730000000_add_mcp_tables already having run.
--
-- NOTE: on a database cloned from production (e.g. limemediaprod_UAT),
-- a leftover Databricks Lakeflow CDC trigger (lakeflowDdlAuditTrigger_1_1)
-- fires on ALTER_TABLE and tries a cross-database write back to
-- limemediaprod, which Azure SQL Database rejects (Msg 40515). It's
-- disabled for the duration of this script and re-enabled at the end.
-- On real limemediaprod this is a harmless few-second pause of a
-- trigger that works fine there (same-database write, not cross-db).
-- ============================================================

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
BEGIN
    DISABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;
    PRINT 'Disabled trigger: lakeflowDdlAuditTrigger_1_1 (will re-enable at end of script)';
END

-- -------------------------------------------------------
-- 1. Add user_type to mcp_tokens
-- -------------------------------------------------------
IF COL_LENGTH('dbo.mcp_tokens', 'user_type') IS NULL
BEGIN
    ALTER TABLE dbo.mcp_tokens
        ADD user_type NVARCHAR(50) NOT NULL
            CONSTRAINT DF_mcp_tokens_user_type DEFAULT 'app_user';
    PRINT 'Added column: mcp_tokens.user_type';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: mcp_tokens.user_type';
END

-- -------------------------------------------------------
-- 2. Drop hard FK on mcp_tokens.user_id → app_users
--    (user_id can now reference app_users or app_client_users
--    depending on user_type — no single-table FK possible)
-- -------------------------------------------------------
IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_NAME = 'FK_mcp_tokens_user'
      AND TABLE_SCHEMA    = 'dbo'
      AND TABLE_NAME      = 'mcp_tokens'
)
BEGIN
    ALTER TABLE dbo.mcp_tokens DROP CONSTRAINT FK_mcp_tokens_user;
    PRINT 'Dropped FK: FK_mcp_tokens_user';
END
ELSE
BEGIN
    PRINT 'FK already dropped or does not exist: FK_mcp_tokens_user';
END

-- -------------------------------------------------------
-- 3. Add user_type to mcp_query_log
-- -------------------------------------------------------
IF COL_LENGTH('dbo.mcp_query_log', 'user_type') IS NULL
BEGIN
    ALTER TABLE dbo.mcp_query_log
        ADD user_type NVARCHAR(50) NULL;
    PRINT 'Added column: mcp_query_log.user_type';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: mcp_query_log.user_type';
END

-- -------------------------------------------------------
-- 4. Drop hard FK on mcp_query_log.user_id → app_users
-- -------------------------------------------------------
IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_NAME = 'FK_mcp_query_log_user'
      AND TABLE_SCHEMA    = 'dbo'
      AND TABLE_NAME      = 'mcp_query_log'
)
BEGIN
    ALTER TABLE dbo.mcp_query_log DROP CONSTRAINT FK_mcp_query_log_user;
    PRINT 'Dropped FK: FK_mcp_query_log_user';
END
ELSE
BEGIN
    PRINT 'FK already dropped or does not exist: FK_mcp_query_log_user';
END

-- -------------------------------------------------------
-- 5. Drop hard FK on mcp_query_log.token_id → mcp_tokens
-- -------------------------------------------------------
IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_NAME = 'FK_mcp_query_log_token'
      AND TABLE_SCHEMA    = 'dbo'
      AND TABLE_NAME      = 'mcp_query_log'
)
BEGIN
    ALTER TABLE dbo.mcp_query_log DROP CONSTRAINT FK_mcp_query_log_token;
    PRINT 'Dropped FK: FK_mcp_query_log_token';
END
ELSE
BEGIN
    PRINT 'FK already dropped or does not exist: FK_mcp_query_log_token';
END

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
BEGIN
    ENABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;
    PRINT 'Re-enabled trigger: lakeflowDdlAuditTrigger_1_1';
END

PRINT 'MCP client-user support migration complete.';

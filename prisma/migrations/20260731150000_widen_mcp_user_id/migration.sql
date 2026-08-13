-- ============================================================
-- Widen mcp_tokens.user_id / mcp_query_log.user_id to NVARCHAR(255)
-- Backfilled migration: already applied to the live database
-- (added by hand alongside commit 8ffc627, "Merge pull request #7
-- from lime-media/fix/widen-mcp-user-id-column: Widen user_id to
-- NVARCHAR(255) on MCP tables", 2026-07-31) but never captured
-- under prisma/migrations — previously lived only as the
-- standalone prisma/mcp-widen-user-id-migration.sql script.
--
-- Client user IDs use a client_ prefix + UUID (43 chars), which
-- exceeded the original NVARCHAR(36), causing P2000 errors on
-- mint. Confirmed via direct introspection (2026-08-10/11) that
-- live limemediaprod is already NVARCHAR(255) on both columns.
--
-- Depends on 20260730000000_add_mcp_tables already having run.
-- Column ALTERs, not additions — no IF-guard available; safe to
-- re-run regardless (widening an already-255 column is a no-op).
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

ALTER TABLE dbo.mcp_tokens
    ALTER COLUMN user_id NVARCHAR(255) NOT NULL;
PRINT 'Widened mcp_tokens.user_id to NVARCHAR(255)';

ALTER TABLE dbo.mcp_query_log
    ALTER COLUMN user_id NVARCHAR(255) NULL;
PRINT 'Widened mcp_query_log.user_id to NVARCHAR(255)';

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
BEGIN
    ENABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;
    PRINT 'Re-enabled trigger: lakeflowDdlAuditTrigger_1_1';
END

PRINT 'Widen MCP user_id migration complete.';

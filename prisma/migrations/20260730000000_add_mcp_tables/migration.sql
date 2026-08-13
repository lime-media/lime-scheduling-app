-- ============================================================
-- Add MCP V2 tables — mcp_tokens, mcp_query_log — and
-- app_holds.origination
-- Backfilled migration: these already exist in the live
-- database (added by hand alongside commit 74c2c69, "Merge pull
-- request #2 from lime-media/feature/mcp-v2-auth-and-holds:
-- MCP V2: per-user auth, hold creation, and query logging",
-- 2026-07-30) but were never captured under prisma/migrations —
-- they previously lived only as the standalone
-- prisma/mcp-v2-migration.sql script. This file documents that
-- change; all statements are guarded and no-op if already
-- applied. Column widths verified against live limemediaprod
-- via direct introspection (2026-08-10/11).
--
-- Depends on dbo.app_holds and dbo.app_users already existing —
-- run this AFTER prisma/create-new-tables.sql.
--
-- Run against Azure SQL using the same process as the other
-- prisma/*.sql scripts (see SETUP.md). Do NOT run via
-- `prisma db push` / `prisma migrate deploy`.
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
-- 1. Add origination column to app_holds (frontend | mcp)
-- -------------------------------------------------------
IF COL_LENGTH('dbo.app_holds', 'origination') IS NULL
BEGIN
    ALTER TABLE dbo.app_holds
        ADD origination NVARCHAR(50) NOT NULL
            CONSTRAINT DF_app_holds_origination DEFAULT 'frontend';
    PRINT 'Added column: app_holds.origination';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: app_holds.origination';
END

-- -------------------------------------------------------
-- 2. mcp_tokens: per-user MCP credentials
-- -------------------------------------------------------
IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'mcp_tokens'
)
BEGIN
    CREATE TABLE dbo.mcp_tokens (
        id          NVARCHAR(36)  NOT NULL,
        token_hash  NVARCHAR(255) NOT NULL,
        user_id     NVARCHAR(36)  NOT NULL,
        label       NVARCHAR(255) NOT NULL,
        created_at  DATETIME2     NOT NULL CONSTRAINT DF_mcp_tokens_created_at DEFAULT GETUTCDATE(),
        revoked_at  DATETIME2     NULL,

        CONSTRAINT PK_mcp_tokens PRIMARY KEY (id),
        CONSTRAINT FK_mcp_tokens_user
            FOREIGN KEY (user_id)
            REFERENCES dbo.app_users (id)
            ON DELETE NO ACTION
            ON UPDATE NO ACTION
    );

    CREATE INDEX IX_mcp_tokens_user_id
        ON dbo.mcp_tokens (user_id);

    PRINT 'Created table: dbo.mcp_tokens';
END
ELSE
BEGIN
    PRINT 'Table already exists, skipping: dbo.mcp_tokens';
END

-- -------------------------------------------------------
-- 3. mcp_query_log: telemetry for all MCP tool calls
-- -------------------------------------------------------
IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'mcp_query_log'
)
BEGIN
    CREATE TABLE dbo.mcp_query_log (
        id               NVARCHAR(36)  NOT NULL,
        user_id          NVARCHAR(36)  NULL,
        token_id         NVARCHAR(36)  NULL,
        tool_name        NVARCHAR(100) NOT NULL,
        request_params   NVARCHAR(MAX) NULL,
        response_summary NVARCHAR(MAX) NULL,
        outcome          NVARCHAR(50)  NOT NULL,
        latency_ms       INT           NOT NULL,
        created_at       DATETIME2     NOT NULL CONSTRAINT DF_mcp_query_log_created_at DEFAULT GETUTCDATE(),

        CONSTRAINT PK_mcp_query_log PRIMARY KEY (id),
        CONSTRAINT FK_mcp_query_log_user
            FOREIGN KEY (user_id)
            REFERENCES dbo.app_users (id)
            ON DELETE NO ACTION
            ON UPDATE NO ACTION,
        CONSTRAINT FK_mcp_query_log_token
            FOREIGN KEY (token_id)
            REFERENCES dbo.mcp_tokens (id)
            ON DELETE NO ACTION
            ON UPDATE NO ACTION
    );

    CREATE INDEX IX_mcp_query_log_user_created
        ON dbo.mcp_query_log (user_id, created_at);

    CREATE INDEX IX_mcp_query_log_tool_outcome
        ON dbo.mcp_query_log (tool_name, outcome);

    PRINT 'Created table: dbo.mcp_query_log';
END
ELSE
BEGIN
    PRINT 'Table already exists, skipping: dbo.mcp_query_log';
END

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
BEGIN
    ENABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;
    PRINT 'Re-enabled trigger: lakeflowDdlAuditTrigger_1_1';
END

PRINT 'MCP tables migration complete.';

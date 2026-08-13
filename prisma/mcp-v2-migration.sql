-- ============================================================
-- MCP V2 Migration — Per-user auth, hold origination, query log
-- Run against Azure SQL (limemediauat). Safe to re-run:
-- all statements use IF NOT EXISTS / IF COL_LENGTH guards.
-- ============================================================

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

    -- Indexes for reporting queries
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

PRINT 'MCP V2 migration complete.';

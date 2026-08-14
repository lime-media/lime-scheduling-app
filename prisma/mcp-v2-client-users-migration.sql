-- ============================================================
-- MCP V2 Client Users Migration
-- Extends mcp_tokens and mcp_query_log to support both
-- app_users (internal) and app_client_users (external).
-- Safe to re-run: all statements use guards.
-- ============================================================

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

PRINT 'MCP V2 client-users migration complete.';

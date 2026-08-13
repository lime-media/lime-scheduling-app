-- ============================================================
-- Widen user_id on mcp_tokens and mcp_query_log to NVARCHAR(255)
-- Fixes P2000 error when client_user IDs exceed 36 chars.
-- Safe to re-run.
-- ============================================================

ALTER TABLE dbo.mcp_tokens
    ALTER COLUMN user_id NVARCHAR(255) NOT NULL;
PRINT 'Widened mcp_tokens.user_id to NVARCHAR(255)';

ALTER TABLE dbo.mcp_query_log
    ALTER COLUMN user_id NVARCHAR(255) NULL;
PRINT 'Widened mcp_query_log.user_id to NVARCHAR(255)';

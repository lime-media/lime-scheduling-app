-- ============================================================
-- Drop Client Portal AI Chat Persistence Tables
-- dbo.client_chat_messages and dbo.client_chat_conversations
-- (added in 20260810000000_add_client_chat_tables)
--
-- The client-portal AI assistant (app/api/client/chat/*) no longer reads or
-- writes conversation history — each visit starts fresh, and there is no
-- code path left that references either table. See the "Remove client-portal
-- chat history/persistence" commit.
--
-- DESTRUCTIVE — these tables have real rows in them (confirmed via direct
-- introspection when 20260810000000 was written: 8 conversations, 30
-- messages, and likely more since). This permanently deletes that history.
-- Do not run this until the code change that stops using these tables is
-- actually deployed to whichever environment you're running this against.
--
-- client_chat_messages is dropped first — it has a foreign key on
-- client_chat_conversations, so the FK must go before the referenced table.
--
-- NOTE: on a database cloned from production (e.g. limemediaprod_UAT), a leftover
-- Databricks Lakeflow CDC trigger (lakeflowDdlAuditTrigger_1_1) fires on DDL
-- statements including DROP TABLE and tries a cross-database write back to
-- limemediaprod, which Azure SQL Database rejects (Msg 40515). It's disabled for
-- the duration of the drops below and re-enabled immediately after — same guard
-- as 20260730000000_add_mcp_tables and 20260814120000_add_company_name_to_client_ai_questions.
-- On real limemediaprod this is a harmless no-op (same-database write there, works fine).
--
-- Run against Azure SQL using the same process as the other prisma/*.sql
-- scripts (see SETUP.md). Do NOT run via `prisma db push` / `prisma migrate
-- deploy` — run it by hand, and only when you're ready.
-- ============================================================

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
BEGIN
    DISABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;
    PRINT 'Disabled trigger: lakeflowDdlAuditTrigger_1_1 (will re-enable at end of script)';
END

IF EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'client_chat_messages'
)
BEGIN
    DROP TABLE dbo.client_chat_messages;
    PRINT 'Dropped table: dbo.client_chat_messages';
END
ELSE
BEGIN
    PRINT 'Table does not exist, skipping: dbo.client_chat_messages';
END

IF EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'client_chat_conversations'
)
BEGIN
    DROP TABLE dbo.client_chat_conversations;
    PRINT 'Dropped table: dbo.client_chat_conversations';
END
ELSE
BEGIN
    PRINT 'Table does not exist, skipping: dbo.client_chat_conversations';
END

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
BEGIN
    ENABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;
    PRINT 'Re-enabled trigger: lakeflowDdlAuditTrigger_1_1';
END

PRINT 'Client chat tables drop complete.';

-- ============================================================
-- Add answer to dbo.app_client_ai_questions
--
-- The assistant's reply is now logged alongside the client's question in the
-- same row, so this table alone shows both sides of every exchange. Existing
-- rows keep the '' default (no answer was captured for them).
--
-- NOTE: on a database cloned from production (e.g. limemediaprod_UAT), a leftover
-- Databricks Lakeflow CDC trigger (lakeflowDdlAuditTrigger_1_1) fires on DDL
-- statements including ALTER TABLE and tries a cross-database write back to
-- limemediaprod, which Azure SQL Database rejects (Msg 40515). It's disabled for
-- the duration of the ALTER TABLE below and re-enabled immediately after — same
-- guard as the other recent migrations on this table. On real limemediaprod this
-- is a harmless no-op (same-database write there, works fine).
--
-- Run against Azure SQL using the same process as the other prisma/*.sql
-- scripts (see SETUP.md). Do NOT run via `prisma db push` / `prisma migrate
-- deploy`.
-- ============================================================

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
BEGIN
    DISABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;
    PRINT 'Disabled trigger: lakeflowDdlAuditTrigger_1_1 (will re-enable after ALTER TABLE)';
END

IF COL_LENGTH('dbo.app_client_ai_questions', 'answer') IS NULL
BEGIN
    ALTER TABLE dbo.app_client_ai_questions
        ADD answer NVARCHAR(MAX) NOT NULL
            CONSTRAINT DF_app_client_ai_questions_answer DEFAULT '';

    PRINT 'Added column: app_client_ai_questions.answer';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: app_client_ai_questions.answer';
END

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
BEGIN
    ENABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;
    PRINT 'Re-enabled trigger: lakeflowDdlAuditTrigger_1_1';
END

PRINT 'app_client_ai_questions.answer migration complete.';

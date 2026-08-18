-- ============================================================
-- Add partner_id to dbo.app_client_users
--
-- Optional link from a client-portal login to app_rate_agreements.partner_id
-- (see sibling migration 20260818000000_add_rate_agreements_and_accepted_
-- markets_tables). Lets the client-portal AI quote engine
-- (app/api/client/chat/route.ts) apply a client's negotiated rate instead
-- of the standard rate card. NULL (the default for every existing row)
-- means "use the standard rate card" — nothing changes for a client
-- until ops explicitly sets this via the admin client-users screen.
--
-- Run against Azure SQL using the same process as the other prisma/*.sql
-- scripts (see SETUP.md). Do NOT run via `prisma db push` / `prisma
-- migrate deploy`.
--
-- NOTE: on a database cloned from production (e.g. limemediaprod_UAT), a leftover
-- Databricks Lakeflow CDC trigger (lakeflowDdlAuditTrigger_1_1) fires on DDL
-- statements including ALTER TABLE and tries a cross-database write back to
-- limemediaprod, which Azure SQL Database rejects (Msg 40515). It's disabled for
-- the duration of the ALTER TABLE below and re-enabled immediately after — same
-- guard as the other recent migrations on this table.
-- ============================================================

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
BEGIN
    DISABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;
    PRINT 'Disabled trigger: lakeflowDdlAuditTrigger_1_1 (will re-enable after ALTER TABLE)';
END

IF COL_LENGTH('dbo.app_client_users', 'partner_id') IS NULL
BEGIN
    ALTER TABLE dbo.app_client_users
        ADD partner_id NVARCHAR(1000) NULL;

    PRINT 'Added column: app_client_users.partner_id';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: app_client_users.partner_id';
END

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
BEGIN
    ENABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;
    PRINT 'Re-enabled trigger: lakeflowDdlAuditTrigger_1_1';
END

PRINT 'app_client_users.partner_id migration complete.';

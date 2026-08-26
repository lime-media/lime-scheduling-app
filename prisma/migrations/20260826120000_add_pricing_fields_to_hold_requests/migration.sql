-- ============================================================
-- Add pricing/expiration columns to app_hold_requests
--
-- Backfills a migration that was never captured: commit 822709e
-- ("Add pricing, expiration, and workflow enforcement to client
-- hold requests", PR #47, merged into uat 2026-08-21) added these
-- fields to the HoldRequest model in prisma/schema.prisma and
-- shipped app code that reads/writes them (app/api/client/chat/
-- route.ts, lib/holdRequestService.ts) — but no migration.sql was
-- ever added alongside it, so the live app_hold_requests table on
-- uat never actually got these columns.
--
-- Effect of the gap: every AI-submitted hold request on uat since
-- PR #47 merged has failed at the DB write with
-- PrismaClientValidationError: Unknown argument `pricing_tier`
-- (confirmed 2026-08-26 while debugging "holds never place" —
-- see app_client_ai_questions log entries from today). Only
-- affects the client-AI assistant, gated to the testclient account;
-- main/production has not merged PR #47 and is unaffected.
--
-- Run against Azure SQL using the same process as the other
-- prisma/*.sql scripts (see SETUP.md). Do NOT run via
-- `prisma db push` / `prisma migrate deploy`.
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

-- -------------------------------------------------------
-- pricing_tier: Good | Better | Best — the tier the client
-- chose from the quote, locked in at hold creation
-- -------------------------------------------------------
IF COL_LENGTH('dbo.app_hold_requests', 'pricing_tier') IS NULL
BEGIN
    ALTER TABLE dbo.app_hold_requests
        ADD pricing_tier NVARCHAR(1000) NULL;
    PRINT 'Added column: app_hold_requests.pricing_tier';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: app_hold_requests.pricing_tier';
END

-- -------------------------------------------------------
-- quoted_total: total price at the selected tier
-- (campaign-level, i.e. across all trucks in the group)
-- -------------------------------------------------------
IF COL_LENGTH('dbo.app_hold_requests', 'quoted_total') IS NULL
BEGIN
    ALTER TABLE dbo.app_hold_requests
        ADD quoted_total FLOAT NULL;
    PRINT 'Added column: app_hold_requests.quoted_total';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: app_hold_requests.quoted_total';
END

-- -------------------------------------------------------
-- daily_rate: per-truck per-day rate at quote time
-- -------------------------------------------------------
IF COL_LENGTH('dbo.app_hold_requests', 'daily_rate') IS NULL
BEGIN
    ALTER TABLE dbo.app_hold_requests
        ADD daily_rate FLOAT NULL;
    PRINT 'Added column: app_hold_requests.daily_rate';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: app_hold_requests.daily_rate';
END

-- -------------------------------------------------------
-- features: JSON snapshot of included add-ons at quote time
-- { smartDirectional, deviceId, studies, shadowFencing }
-- -------------------------------------------------------
IF COL_LENGTH('dbo.app_hold_requests', 'features') IS NULL
BEGIN
    ALTER TABLE dbo.app_hold_requests
        ADD features NVARCHAR(MAX) NULL;
    PRINT 'Added column: app_hold_requests.features';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: app_hold_requests.features';
END

-- -------------------------------------------------------
-- truck_count: total trucks in the campaign group this
-- hold request belongs to (not just this one row)
-- -------------------------------------------------------
IF COL_LENGTH('dbo.app_hold_requests', 'truck_count') IS NULL
BEGIN
    ALTER TABLE dbo.app_hold_requests
        ADD truck_count INT NULL;
    PRINT 'Added column: app_hold_requests.truck_count';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: app_hold_requests.truck_count';
END

-- -------------------------------------------------------
-- campaign_group_id: links multi-truck holds submitted in
-- the same request together
-- -------------------------------------------------------
IF COL_LENGTH('dbo.app_hold_requests', 'campaign_group_id') IS NULL
BEGIN
    ALTER TABLE dbo.app_hold_requests
        ADD campaign_group_id NVARCHAR(1000) NULL;
    PRINT 'Added column: app_hold_requests.campaign_group_id';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: app_hold_requests.campaign_group_id';
END

-- -------------------------------------------------------
-- expires_at: 72h-from-creation default. Internal only —
-- never shown to the client.
-- -------------------------------------------------------
IF COL_LENGTH('dbo.app_hold_requests', 'expires_at') IS NULL
BEGIN
    ALTER TABLE dbo.app_hold_requests
        ADD expires_at DATETIME2 NULL;
    PRINT 'Added column: app_hold_requests.expires_at';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: app_hold_requests.expires_at';
END

-- -------------------------------------------------------
-- extension_reason: client's stated reason when requesting
-- a hold extension (status EXTENSION_REQUESTED)
-- -------------------------------------------------------
IF COL_LENGTH('dbo.app_hold_requests', 'extension_reason') IS NULL
BEGIN
    ALTER TABLE dbo.app_hold_requests
        ADD extension_reason NVARCHAR(MAX) NULL;
    PRINT 'Added column: app_hold_requests.extension_reason';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: app_hold_requests.extension_reason';
END

-- Index to support lookups of every row in a campaign group
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_app_hold_requests_campaign_group_id'
      AND object_id = OBJECT_ID('dbo.app_hold_requests')
)
BEGIN
    CREATE INDEX IX_app_hold_requests_campaign_group_id
        ON dbo.app_hold_requests (campaign_group_id);
    PRINT 'Created index: IX_app_hold_requests_campaign_group_id';
END
ELSE
BEGIN
    PRINT 'Index already exists, skipping: IX_app_hold_requests_campaign_group_id';
END

IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'lakeflowDdlAuditTrigger_1_1' AND parent_class_desc = 'DATABASE')
BEGIN
    ENABLE TRIGGER lakeflowDdlAuditTrigger_1_1 ON DATABASE;
    PRINT 'Re-enabled trigger: lakeflowDdlAuditTrigger_1_1';
END

PRINT 'app_hold_requests pricing/expiration columns migration complete.';

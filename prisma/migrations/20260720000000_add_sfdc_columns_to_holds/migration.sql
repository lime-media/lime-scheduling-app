-- ============================================================
-- Add Salesforce columns to app_holds
-- Backfilled migration: these columns already exist in the live
-- database (added by hand alongside commit 698488d, "Add
-- Salesforce hold-push webhook and auto-release on conversion
-- to booked", 2026-07-20) but were never captured as a tracked
-- SQL script. This file documents that change retroactively;
-- it does not need to be re-run against limemediaprod if the
-- columns already exist — all statements are guarded.
--
-- Run against Azure SQL using the same process as the other
-- prisma/*.sql scripts (see SETUP.md). Do NOT run via
-- `prisma db push` / `prisma migrate deploy`.
-- ============================================================

-- -------------------------------------------------------
-- sfdc_opportunity_id: set only for holds pushed in from
-- Salesforce; lets repeat pushes for the same Opportunity
-- update the existing hold instead of creating duplicates.
-- -------------------------------------------------------
IF COL_LENGTH('dbo.app_holds', 'sfdc_opportunity_id') IS NULL
BEGIN
    ALTER TABLE dbo.app_holds
        ADD sfdc_opportunity_id NVARCHAR(255) NULL;
    PRINT 'Added column: app_holds.sfdc_opportunity_id';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: app_holds.sfdc_opportunity_id';
END

-- -------------------------------------------------------
-- sfdc_hold_exp: expiration date carried over from the
-- Salesforce Opportunity's hold-expiration field
-- -------------------------------------------------------
IF COL_LENGTH('dbo.app_holds', 'sfdc_hold_exp') IS NULL
BEGIN
    ALTER TABLE dbo.app_holds
        ADD sfdc_hold_exp DATETIME2 NULL;
    PRINT 'Added column: app_holds.sfdc_hold_exp';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: app_holds.sfdc_hold_exp';
END

-- Index to support the webhook's upsert lookup by Opportunity
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_app_holds_sfdc_opportunity_id'
      AND object_id = OBJECT_ID('dbo.app_holds')
)
BEGIN
    CREATE INDEX IX_app_holds_sfdc_opportunity_id
        ON dbo.app_holds (sfdc_opportunity_id);
    PRINT 'Created index: IX_app_holds_sfdc_opportunity_id';
END
ELSE
BEGIN
    PRINT 'Index already exists, skipping: IX_app_holds_sfdc_opportunity_id';
END

PRINT 'Salesforce columns migration complete.';

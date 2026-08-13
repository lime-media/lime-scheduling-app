-- ============================================================
-- Add `source` column to app_holds and app_hold_requests
-- Backfilled migration: this column already exists in the live
-- database (added alongside commit bf44fa0, "AI-fix",
-- 2026-07-24, which introduced the source-attribution work for
-- the Salesforce integration) but was never captured as a
-- tracked SQL script. This file documents that change
-- retroactively; it does not need to be re-run against
-- limemediaprod if the columns already exist — all statements
-- are guarded.
--
-- source values: 'INTERNAL' | 'SALESFORCE' | 'CLIENT'
--
-- Run against Azure SQL using the same process as the other
-- prisma/*.sql scripts (see SETUP.md). Do NOT run via
-- `prisma db push` / `prisma migrate deploy`.
-- ============================================================

-- -------------------------------------------------------
-- app_holds.source (default 'INTERNAL' — covers existing
-- manual-creation and AT&T-sync code paths automatically)
-- -------------------------------------------------------
IF COL_LENGTH('dbo.app_holds', 'source') IS NULL
BEGIN
    ALTER TABLE dbo.app_holds
        ADD source NVARCHAR(50) NOT NULL
            CONSTRAINT DF_app_holds_source DEFAULT 'INTERNAL';
    PRINT 'Added column: app_holds.source';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: app_holds.source';
END

-- -------------------------------------------------------
-- app_hold_requests.source (default 'CLIENT' — covers the
-- existing client-portal code path automatically)
-- -------------------------------------------------------
IF COL_LENGTH('dbo.app_hold_requests', 'source') IS NULL
BEGIN
    ALTER TABLE dbo.app_hold_requests
        ADD source NVARCHAR(50) NOT NULL
            CONSTRAINT DF_app_hold_requests_source DEFAULT 'CLIENT';
    PRINT 'Added column: app_hold_requests.source';
END
ELSE
BEGIN
    PRINT 'Column already exists, skipping: app_hold_requests.source';
END

PRINT 'Source column migration complete.';

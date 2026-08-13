-- ============================================================
-- Add Client Portal — app_client_users + app_hold_requests
-- Backfilled migration: these tables already exist in the live
-- database (added by hand alongside commit faa19bc, "Add client
-- portal, hold requests, user management, and grid fixes",
-- 2026-07-06) but were never captured as a tracked SQL script.
-- This file documents that change retroactively; it does not
-- need to be re-run against limemediaprod if the tables already
-- exist — all statements are guarded and will no-op.
--
-- Run against Azure SQL using the same process as the other
-- prisma/*.sql scripts (see SETUP.md). Do NOT run via
-- `prisma db push` / `prisma migrate deploy`.
--
-- CORRECTION (2026-08-10): the column lengths below (NVARCHAR 36/
-- 255/100/50) were this file's original guess at what was "added
-- by hand," but direct introspection of live limemediaprod shows
-- both tables were actually created via `prisma db push` at some
-- point, using Prisma's default sqlserver mapping — NVARCHAR(1000)
-- on every String column with no @db.NVarChar override, and MAX on
-- notes. Widened below to match reality; this bit a fresh
-- environment built from this file (UAT), because the sibling
-- 20260810000000_add_client_chat_tables migration FKs against
-- app_client_users.id and requires an exact length match.
-- ============================================================

-- -------------------------------------------------------
-- app_client_users: login accounts for the client portal
-- -------------------------------------------------------
IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'app_client_users'
)
BEGIN
    CREATE TABLE dbo.app_client_users (
        id            NVARCHAR(1000) NOT NULL,
        username      NVARCHAR(1000) NOT NULL,
        password_hash NVARCHAR(1000) NOT NULL,
        company_name  NVARCHAR(1000) NOT NULL,
        created_at    DATETIME2      NOT NULL CONSTRAINT DF_app_client_users_created_at DEFAULT GETUTCDATE(),

        CONSTRAINT PK_app_client_users PRIMARY KEY (id),
        CONSTRAINT UQ_app_client_users_username UNIQUE (username)
    );
    PRINT 'Created table: dbo.app_client_users';
END
ELSE
BEGIN
    PRINT 'Table already exists, skipping: dbo.app_client_users';
END

-- -------------------------------------------------------
-- app_hold_requests: client-submitted requests awaiting
-- operations/sales approval
-- status: 'PENDING' | 'APPROVED' | 'REJECTED'
-- -------------------------------------------------------
IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'app_hold_requests'
)
BEGIN
    CREATE TABLE dbo.app_hold_requests (
        id             NVARCHAR(1000) NOT NULL,
        client_user_id NVARCHAR(1000) NOT NULL,
        truck_number   NVARCHAR(1000) NOT NULL,
        market         NVARCHAR(1000) NOT NULL,
        state          NVARCHAR(1000) NULL,
        start_date     DATETIME2      NOT NULL,
        end_date       DATETIME2      NOT NULL,
        notes          NVARCHAR(MAX)  NULL,
        status         NVARCHAR(1000) NOT NULL CONSTRAINT DF_app_hold_requests_status DEFAULT 'PENDING',
        created_at     DATETIME2      NOT NULL CONSTRAINT DF_app_hold_requests_created_at DEFAULT GETUTCDATE(),

        CONSTRAINT PK_app_hold_requests PRIMARY KEY (id),
        CONSTRAINT FK_app_hold_requests_client_user
            FOREIGN KEY (client_user_id)
            REFERENCES dbo.app_client_users (id)
            ON DELETE NO ACTION
            ON UPDATE NO ACTION
    );

    -- Index for fast truck + date range lookups
    CREATE INDEX IX_app_hold_requests_truck_dates
        ON dbo.app_hold_requests (truck_number, start_date, end_date);

    -- Index for looking up requests by client
    CREATE INDEX IX_app_hold_requests_client_user_id
        ON dbo.app_hold_requests (client_user_id);

    PRINT 'Created table: dbo.app_hold_requests';
END
ELSE
BEGIN
    PRINT 'Table already exists, skipping: dbo.app_hold_requests';
END

PRINT 'Client portal migration complete.';

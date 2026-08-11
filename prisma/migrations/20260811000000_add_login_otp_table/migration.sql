-- ============================================================
-- Add Login OTP table — dbo.app_login_otps
-- New migration (not a backfill) — backs email-OTP verification
-- for internal staff login (lib/otp.ts, lib/auth.ts). Run this
-- BEFORE that code path goes live against any environment.
--
-- One active (non-consumed) row per user at a time — the
-- request-otp flow deletes any prior unconsumed row for a user
-- before inserting a new one.
--
-- Depends on dbo.app_users already existing — run this AFTER
-- prisma/create-new-tables.sql.
--
-- Run against Azure SQL using the same process as the other
-- prisma/*.sql scripts (see SETUP.md). Do NOT run via
-- `prisma db push` / `prisma migrate deploy`.
-- ============================================================

IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'app_login_otps'
)
BEGIN
    CREATE TABLE dbo.app_login_otps (
        id          NVARCHAR(36)  NOT NULL,
        user_id     NVARCHAR(36)  NOT NULL,
        code_hash   NVARCHAR(255) NOT NULL,
        expires_at  DATETIME2     NOT NULL,
        attempts    INT           NOT NULL CONSTRAINT DF_app_login_otps_attempts DEFAULT 0,
        consumed_at DATETIME2     NULL,
        created_at  DATETIME2     NOT NULL CONSTRAINT DF_app_login_otps_created_at DEFAULT GETUTCDATE(),

        CONSTRAINT PK_app_login_otps PRIMARY KEY (id),
        CONSTRAINT FK_app_login_otps_user
            FOREIGN KEY (user_id)
            REFERENCES dbo.app_users (id)
            ON DELETE CASCADE
            ON UPDATE NO ACTION
    );

    -- Index for the "find this user's latest OTP" lookup on every
    -- request-otp / verify call
    CREATE INDEX IX_app_login_otps_user_id
        ON dbo.app_login_otps (user_id, created_at);

    PRINT 'Created table: dbo.app_login_otps';
END
ELSE
BEGIN
    PRINT 'Table already exists, skipping: dbo.app_login_otps';
END

PRINT 'Login OTP table migration complete.';

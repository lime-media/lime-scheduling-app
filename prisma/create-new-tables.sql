-- ============================================================
-- Lime Media Scheduling Assistant — New Table Setup
-- Run this ONCE against Azure SQL (limemediauat) to create
-- the three application tables. Safe to re-run: all statements
-- use IF NOT EXISTS guards and will no-op if tables exist.
-- Does NOT touch any existing dbo.led_app_* or samsara_* tables.
-- ============================================================

-- -------------------------------------------------------
-- app_users: login accounts for the scheduling assistant
-- role: 'SALES' | 'OPERATIONS'
-- -------------------------------------------------------
IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'app_users'
)
BEGIN
    CREATE TABLE dbo.app_users (
        id            NVARCHAR(36)  NOT NULL,
        email         NVARCHAR(255) NOT NULL,
        name          NVARCHAR(255) NOT NULL,
        password_hash NVARCHAR(255) NOT NULL,
        role          NVARCHAR(50)  NOT NULL CONSTRAINT DF_app_users_role DEFAULT 'SALES',
        created_at    DATETIME2     NOT NULL CONSTRAINT DF_app_users_created_at DEFAULT GETUTCDATE(),

        CONSTRAINT PK_app_users PRIMARY KEY (id),
        CONSTRAINT UQ_app_users_email UNIQUE (email)
    );
    PRINT 'Created table: dbo.app_users';
END
ELSE
BEGIN
    PRINT 'Table already exists, skipping: dbo.app_users';
END

-- -------------------------------------------------------
-- app_holds: truck holds and committed bookings
-- status: 'HOLD' | 'COMMITTED'
-- -------------------------------------------------------
IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'app_holds'
)
BEGIN
    CREATE TABLE dbo.app_holds (
        id           NVARCHAR(36)   NOT NULL,
        truck_number NVARCHAR(100)  NOT NULL,
        market       NVARCHAR(255)  NOT NULL,
        state        NVARCHAR(100)  NOT NULL,
        client_name  NVARCHAR(255)  NOT NULL,
        start_date   DATETIME2      NOT NULL,
        end_date     DATETIME2      NOT NULL,
        status       NVARCHAR(50)   NOT NULL CONSTRAINT DF_app_holds_status DEFAULT 'HOLD',
        notes        NVARCHAR(MAX)  NULL,
        created_by   NVARCHAR(36)   NOT NULL,
        created_at   DATETIME2      NOT NULL CONSTRAINT DF_app_holds_created_at DEFAULT GETUTCDATE(),
        updated_at   DATETIME2      NOT NULL CONSTRAINT DF_app_holds_updated_at DEFAULT GETUTCDATE(),

        CONSTRAINT PK_app_holds PRIMARY KEY (id),
        CONSTRAINT FK_app_holds_user
            FOREIGN KEY (created_by)
            REFERENCES dbo.app_users (id)
            ON DELETE NO ACTION
            ON UPDATE NO ACTION
    );

    -- Index for fast truck + date range lookups
    CREATE INDEX IX_app_holds_truck_dates
        ON dbo.app_holds (truck_number, start_date, end_date);

    -- Index for looking up holds by creator
    CREATE INDEX IX_app_holds_created_by
        ON dbo.app_holds (created_by);

    PRINT 'Created table: dbo.app_holds';
END
ELSE
BEGIN
    PRINT 'Table already exists, skipping: dbo.app_holds';
END

-- -------------------------------------------------------
-- app_audit_logs: full audit trail of hold actions
-- action examples: 'CREATE_HOLD', 'UPDATE_HOLD', 'DELETE_HOLD'
-- -------------------------------------------------------
IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'app_audit_logs'
)
BEGIN
    CREATE TABLE dbo.app_audit_logs (
        id           NVARCHAR(36)  NOT NULL,
        action       NVARCHAR(100) NOT NULL,
        truck_number NVARCHAR(100) NOT NULL,
        user_id      NVARCHAR(36)  NOT NULL,
        hold_id      NVARCHAR(36)  NULL,
        details      NVARCHAR(MAX) NULL,
        created_at   DATETIME2     NOT NULL CONSTRAINT DF_app_audit_logs_created_at DEFAULT GETUTCDATE(),

        CONSTRAINT PK_app_audit_logs PRIMARY KEY (id),
        CONSTRAINT FK_app_audit_logs_user
            FOREIGN KEY (user_id)
            REFERENCES dbo.app_users (id)
            ON DELETE NO ACTION
            ON UPDATE NO ACTION,
        CONSTRAINT FK_app_audit_logs_hold
            FOREIGN KEY (hold_id)
            REFERENCES dbo.app_holds (id)
            ON DELETE NO ACTION
            ON UPDATE NO ACTION
    );

    -- Index for querying audit history by user or hold
    CREATE INDEX IX_app_audit_logs_user_id
        ON dbo.app_audit_logs (user_id);

    CREATE INDEX IX_app_audit_logs_hold_id
        ON dbo.app_audit_logs (hold_id);

    PRINT 'Created table: dbo.app_audit_logs';
END
ELSE
BEGIN
    PRINT 'Table already exists, skipping: dbo.app_audit_logs';
END

PRINT 'Done. Run the seed script next to create default users.';

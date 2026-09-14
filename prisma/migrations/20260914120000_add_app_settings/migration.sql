-- Editable application settings (notification recipients, etc).
--
-- Safe to re-run: guarded on existence, and seeds only when the key is absent.
-- No data is modified — this table does not exist before this migration.

IF NOT EXISTS (
    SELECT 1 FROM sys.tables WHERE name = 'app_settings' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
    CREATE TABLE [dbo].[app_settings] (
        [key]        NVARCHAR(200)  NOT NULL,
        [value]      NVARCHAR(MAX)  NOT NULL,
        [updated_at] DATETIME2      NOT NULL CONSTRAINT [DF_app_settings_updated_at] DEFAULT SYSUTCDATETIME(),
        [updated_by] NVARCHAR(450)  NULL,
        CONSTRAINT [PK_app_settings] PRIMARY KEY CLUSTERED ([key])
    );
END;

-- Seed the notification recipients with the values currently compiled into
-- lib/email.ts, so behavior is identical the moment this lands and the UI has
-- something to show rather than three blank fields.
IF NOT EXISTS (SELECT 1 FROM [dbo].[app_settings] WHERE [key] = 'notify.holds')
    INSERT INTO [dbo].[app_settings] ([key], [value], [updated_by])
    VALUES ('notify.holds', 'andrew@lime-media.com', NULL);

IF NOT EXISTS (SELECT 1 FROM [dbo].[app_settings] WHERE [key] = 'notify.assist')
    INSERT INTO [dbo].[app_settings] ([key], [value], [updated_by])
    VALUES ('notify.assist', 'andrew@lime-media.com', NULL);

IF NOT EXISTS (SELECT 1 FROM [dbo].[app_settings] WHERE [key] = 'notify.conflicts')
    INSERT INTO [dbo].[app_settings] ([key], [value], [updated_by])
    VALUES ('notify.conflicts', 'andrew@lime-media.com', NULL);

-- ── Verify ───────────────────────────────────────────────────────────────────
-- Expect: table exists, 4 columns, 3 seeded rows.
SELECT
    (SELECT COUNT(*) FROM sys.tables  WHERE name = 'app_settings')                      AS table_exists,
    (SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('dbo.app_settings'))  AS column_count,
    (SELECT COUNT(*) FROM [dbo].[app_settings] WHERE [key] LIKE 'notify.%')             AS notify_rows;

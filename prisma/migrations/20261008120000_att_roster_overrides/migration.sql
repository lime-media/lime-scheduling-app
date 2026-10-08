-- Manual changes to the AT&T truck list (lib/attSoftHolds.ts).
--
-- The list is otherwise automatic: a truck with more than 5 days of 160over90
-- work in the month is AT&T's. A row here overrides that for a date range:
--   ADD     the truck is on the AT&T list for those dates (gets soft holds)
--   REMOVE  the truck is off the AT&T list for those dates (soft holds cut)
-- Every row has an end date; after it, the automatic rule applies again.
-- Undo sets removed_at (the row is kept, as history).
--
-- Run BEFORE deploying the code (the soft-hold sync reads this table).
-- Safe to re-run: guarded on existence. New table; no existing data touched.
-- No GO separators: works in sqlcmd, SSMS, Azure Data Studio or the portal.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'app_att_roster_overrides' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    CREATE TABLE [dbo].[app_att_roster_overrides] (
        [id]              NVARCHAR(36)   NOT NULL,
        [truck_number]    NVARCHAR(50)   NOT NULL,
        [action]          NVARCHAR(10)   NOT NULL,
        [start_date]      DATE           NOT NULL,
        [end_date]        DATE           NOT NULL,
        [reason]          NVARCHAR(500)  NOT NULL,
        [created_by]      NVARCHAR(450)  NOT NULL,
        [created_by_name] NVARCHAR(200)  NOT NULL CONSTRAINT [DF_app_att_roster_overrides_created_by_name] DEFAULT '',
        [created_at]      DATETIME2      NOT NULL CONSTRAINT [DF_app_att_roster_overrides_created_at] DEFAULT SYSUTCDATETIME(),
        [removed_at]      DATETIME2      NULL,
        [removed_by]      NVARCHAR(450)  NULL,
        CONSTRAINT [PK_app_att_roster_overrides] PRIMARY KEY CLUSTERED ([id]),
        CONSTRAINT [CK_app_att_roster_overrides_action] CHECK ([action] IN ('ADD', 'REMOVE')),
        CONSTRAINT [CK_app_att_roster_overrides_dates] CHECK ([end_date] >= [start_date])
    );
    CREATE NONCLUSTERED INDEX [IX_app_att_roster_overrides_active] ON [dbo].[app_att_roster_overrides] ([removed_at], [end_date]);
END;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- Expect: table_exists 1, column_count 11, index_exists 1.
SELECT
    (SELECT COUNT(*) FROM sys.tables  WHERE name = 'app_att_roster_overrides')                     AS table_exists,
    (SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('dbo.app_att_roster_overrides')) AS column_count,
    (SELECT COUNT(*) FROM sys.indexes WHERE name = 'IX_app_att_roster_overrides_active')            AS index_exists;

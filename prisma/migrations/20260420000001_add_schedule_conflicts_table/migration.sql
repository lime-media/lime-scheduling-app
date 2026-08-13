-- ============================================================
-- Add dbo.schedule_conflicts
-- Backfilled migration: this table already exists in the live
-- database (it's read/written from the app's initial commit
-- onward, via lib/scheduleCache.ts's detectConflicts() and
-- app/api/conflicts/*) but was never captured as a tracked SQL
-- script. This file documents that change retroactively; it
-- does not need to be re-run against limemediaprod if the table
-- already exists — all statements are guarded.
--
-- Not a Prisma model — like chat_conversations/chat_messages,
-- this table is queried via raw SQL (lib/mssql.ts), not the
-- Prisma client, so it has no corresponding entry in
-- prisma/schema.prisma.
--
-- Depends on dbo.app_holds and dbo.app_users already existing —
-- run this AFTER prisma/create-new-tables.sql.
--
-- status: 'ACTIVE' | 'RESOLVED'
--
-- Run against Azure SQL using the same process as the other
-- prisma/*.sql scripts (see SETUP.md). Do NOT run via
-- `prisma db push` / `prisma migrate deploy`.
-- ============================================================

IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'schedule_conflicts'
)
BEGIN
    CREATE TABLE dbo.schedule_conflicts (
        id                NVARCHAR(36)  NOT NULL,
        hold_id           NVARCHAR(36)  NOT NULL,
        truck_number      NVARCHAR(100) NOT NULL,
        conflict_start    DATETIME2     NOT NULL,
        conflict_end      DATETIME2     NOT NULL,
        hold_client       NVARCHAR(255) NOT NULL,
        hold_market       NVARCHAR(255) NOT NULL,
        scheduled_program NVARCHAR(255) NOT NULL,
        status            NVARCHAR(50)  NOT NULL CONSTRAINT DF_schedule_conflicts_status DEFAULT 'ACTIVE',
        detected_at       DATETIME2     NOT NULL CONSTRAINT DF_schedule_conflicts_detected_at DEFAULT GETUTCDATE(),
        resolved_at       DATETIME2     NULL,
        resolved_by       NVARCHAR(36)  NULL,

        CONSTRAINT PK_schedule_conflicts PRIMARY KEY (id),
        -- ON DELETE CASCADE: releasing/deleting the hold (app/api/conflicts/[id]
        -- "release-hold" action) relies on the conflict row disappearing automatically.
        CONSTRAINT FK_schedule_conflicts_hold
            FOREIGN KEY (hold_id)
            REFERENCES dbo.app_holds (id)
            ON DELETE CASCADE,
        CONSTRAINT FK_schedule_conflicts_resolved_by
            FOREIGN KEY (resolved_by)
            REFERENCES dbo.app_users (id)
            ON DELETE NO ACTION
            ON UPDATE NO ACTION
    );

    -- Index for the active-conflicts list query (app/api/conflicts GET)
    CREATE INDEX IX_schedule_conflicts_status_detected
        ON dbo.schedule_conflicts (status, detected_at);

    -- Index for the dedupe lookup in detectConflicts()
    CREATE INDEX IX_schedule_conflicts_hold_truck_dates
        ON dbo.schedule_conflicts (hold_id, truck_number, conflict_start, conflict_end);

    PRINT 'Created table: dbo.schedule_conflicts';
END
ELSE
BEGIN
    PRINT 'Table already exists, skipping: dbo.schedule_conflicts';
END

PRINT 'Schedule conflicts migration complete.';

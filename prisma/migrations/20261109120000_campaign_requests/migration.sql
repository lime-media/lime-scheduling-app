-- Each booking's CampaignIQ campaign request (source SCHEDULING_APP): the
-- app creates one per booking in Core, keeps it in step while held, converts
-- it on Closed Won and declines it on a lapse or Closed Lost
-- (lib/campaignRequests.ts builds what is sent).
--
-- One row per booking. booking_key is the booking's key now (lib/bookings.ts
-- bookingKey); a revision replaces the holds under a new key, and the revise
-- renames the row in the same transaction. external_ref is what Core was
-- first sent, the key the booking had then, and never changes, so Core keeps
-- one request across any number of revisions and a repeated create still
-- returns it. Core's uid is stored once Core returns it; after that the app
-- only ever addresses the request by it. last_sent_hash is the
-- fingerprint of what was last sent, so an unchanged booking isn't resent.
-- last_error is Core's refusal reason, verbatim, shown on the reservation.
--
-- Nothing fills this table yet; the Core client does once the endpoints are
-- on Core UAT. Run BEFORE deploying: a revise renames its booking's row here.
-- Safe to re-run: guarded on the table, the column and each index. A new
-- table only (a copy made by an earlier version of this script gains
-- external_ref).
-- No GO separators: works in sqlcmd, SSMS, Azure Data Studio or the portal.

-- The filtered unique index below needs these on; classic sqlcmd turns
-- QUOTED_IDENTIFIER off unless run with -I.
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;

IF OBJECT_ID('dbo.app_campaign_requests', 'U') IS NULL
    CREATE TABLE [dbo].[app_campaign_requests] (
        [booking_key]      NVARCHAR(191)    NOT NULL CONSTRAINT [PK_app_campaign_requests] PRIMARY KEY,
        [external_ref]     NVARCHAR(191)    NOT NULL,
        [core_uid]         UNIQUEIDENTIFIER NULL,
        [request_id]       NVARCHAR(20)     NULL,
        [core_status]      NVARCHAR(20)     NULL,
        [program_uid]      UNIQUEIDENTIFIER NULL,
        [last_sent_hash]   NVARCHAR(64)     NULL,
        [last_sent_at]     DATETIME2        NULL,
        [last_error]       NVARCHAR(MAX)    NULL,
        [last_error_at]    DATETIME2        NULL,
        [created_at]       DATETIME2        NOT NULL CONSTRAINT [DF_app_campaign_requests_created_at] DEFAULT SYSUTCDATETIME(),
        [updated_at]       DATETIME2        NOT NULL CONSTRAINT [DF_app_campaign_requests_updated_at] DEFAULT SYSUTCDATETIME()
    );

-- An earlier copy gains it filled from booking_key (a row in it was never
-- revised), then NOT NULL. In EXEC: a column added here can't be named
-- elsewhere in the same batch.
IF COL_LENGTH('dbo.app_campaign_requests', 'external_ref') IS NULL
BEGIN
    ALTER TABLE [dbo].[app_campaign_requests] ADD [external_ref] NVARCHAR(191) NULL;
    EXEC('UPDATE [dbo].[app_campaign_requests] SET [external_ref] = [booking_key] WHERE [external_ref] IS NULL');
    EXEC('ALTER TABLE [dbo].[app_campaign_requests] ALTER COLUMN [external_ref] NVARCHAR(191) NOT NULL');
END

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_app_campaign_requests_external_ref' AND object_id = OBJECT_ID('dbo.app_campaign_requests'))
    EXEC('CREATE UNIQUE INDEX [UX_app_campaign_requests_external_ref] ON [dbo].[app_campaign_requests] ([external_ref])');

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_app_campaign_requests_core_uid' AND object_id = OBJECT_ID('dbo.app_campaign_requests'))
    CREATE UNIQUE INDEX [UX_app_campaign_requests_core_uid] ON [dbo].[app_campaign_requests] ([core_uid]) WHERE [core_uid] IS NOT NULL;

-- Verify. Expected: request_table 1, external_ref 1, external_ref_index 1, core_uid_index 1.
SELECT
    CASE WHEN OBJECT_ID('dbo.app_campaign_requests', 'U') IS NULL THEN 0 ELSE 1 END AS request_table,
    CASE WHEN COL_LENGTH('dbo.app_campaign_requests', 'external_ref') IS NULL THEN 0 ELSE 1 END AS external_ref,
    (SELECT COUNT(*) FROM sys.indexes WHERE name = 'UX_app_campaign_requests_external_ref' AND object_id = OBJECT_ID('dbo.app_campaign_requests')) AS external_ref_index,
    (SELECT COUNT(*) FROM sys.indexes WHERE name = 'UX_app_campaign_requests_core_uid' AND object_id = OBJECT_ID('dbo.app_campaign_requests')) AS core_uid_index;

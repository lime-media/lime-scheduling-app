-- Each booking's CampaignIQ campaign request (source SCHEDULING_APP): the
-- app creates one per booking in Core, keeps it in step while held, converts
-- it on Closed Won and declines it on a lapse or Closed Lost
-- (lib/campaignRequests.ts builds what is sent).
--
-- One row per booking (booking_key = lib/bookings.ts bookingKey, also sent
-- to Core as external_ref). Core's uid is stored once Core returns it; after
-- that the app only ever addresses the request by it. last_sent_hash is the
-- fingerprint of what was last sent, so an unchanged booking isn't resent.
-- last_error is Core's refusal reason, verbatim, shown on the reservation.
--
-- Nothing writes this table yet; the Core client fills it once the endpoints
-- are on Core UAT. Run before or after deploying: no existing model gains a
-- column. Safe to re-run: guarded on the table. A new table only.
-- No GO separators: works in sqlcmd, SSMS, Azure Data Studio or the portal.

IF OBJECT_ID('dbo.app_campaign_requests', 'U') IS NULL
    CREATE TABLE [dbo].[app_campaign_requests] (
        [booking_key]      NVARCHAR(191)    NOT NULL CONSTRAINT [PK_app_campaign_requests] PRIMARY KEY,
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

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_app_campaign_requests_core_uid' AND object_id = OBJECT_ID('dbo.app_campaign_requests'))
    CREATE UNIQUE INDEX [UX_app_campaign_requests_core_uid] ON [dbo].[app_campaign_requests] ([core_uid]) WHERE [core_uid] IS NOT NULL;

-- Verify. Expected: request_table 1, core_uid_index 1.
SELECT
    CASE WHEN OBJECT_ID('dbo.app_campaign_requests', 'U') IS NULL THEN 0 ELSE 1 END AS request_table,
    (SELECT COUNT(*) FROM sys.indexes WHERE name = 'UX_app_campaign_requests_core_uid' AND object_id = OBJECT_ID('dbo.app_campaign_requests')) AS core_uid_index;

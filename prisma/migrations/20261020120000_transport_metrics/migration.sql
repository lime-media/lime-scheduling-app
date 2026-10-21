-- Transport and deal-value metrics (lib/transportMetrics.ts, /ops/transport).
--
--   app_transport_legs  One row per truck per event: what transport was quoted
--                       when a booking was made (BOOKED), changed (SWAPPED,
--                       REVISED), and what actually happened on the campaign's
--                       first day (EXECUTED; its origin taken, when the
--                       truck had no prior job, from a PRESTART snapshot
--                       recorded up to 3 days before it moved): origin,
--                       miles, travel days,
--                       local / absorbed / billed, what we charged and our
--                       estimated cost.
--   app_deal_values     The app's quoted total per booking (BOOKED, REVISED)
--                       against Salesforce's Amount when the opportunity is
--                       Closed Won (WON) and whenever it changes after
--                       (AMOUNT_CHANGED).
--
-- Run BEFORE deploying the code. The code writes these tables best-effort (a
-- missing table never fails a booking), but nothing is recorded until they exist.
-- Safe to re-run: guarded on existence. New tables; no existing data touched.
-- No GO separators: works in sqlcmd, SSMS, Azure Data Studio or the portal.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'app_transport_legs' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    CREATE TABLE [dbo].[app_transport_legs] (
        [id]                  NVARCHAR(36)   NOT NULL,
        [created_at]          DATETIME2      NOT NULL CONSTRAINT [DF_app_transport_legs_created_at] DEFAULT SYSUTCDATETIME(),
        [event]               NVARCHAR(20)   NOT NULL,
        [hold_id]             NVARCHAR(36)   NULL,
        [booking_key]         NVARCHAR(100)  NULL,
        [sfdc_opportunity_id] NVARCHAR(18)   NULL,
        [client_name]         NVARCHAR(255)  NOT NULL CONSTRAINT [DF_app_transport_legs_client_name] DEFAULT '',
        [market]              NVARCHAR(200)  NOT NULL CONSTRAINT [DF_app_transport_legs_market] DEFAULT '',
        [campaign_start]      DATE           NULL,
        [campaign_end]        DATE           NULL,
        [activation_days]     INT            NULL,
        [lead_business_days]  INT            NULL,
        [truck_number]        NVARCHAR(50)   NOT NULL,
        [origin_label]        NVARCHAR(200)  NOT NULL CONSTRAINT [DF_app_transport_legs_origin_label] DEFAULT '',
        [origin_kind]         NVARCHAR(20)   NOT NULL,
        [miles]               INT            NULL,
        [transport_days]      INT            NOT NULL CONSTRAINT [DF_app_transport_legs_transport_days] DEFAULT 0,
        [outcome]             NVARCHAR(20)   NOT NULL,
        [charge]              DECIMAL(12, 2) NOT NULL CONSTRAINT [DF_app_transport_legs_charge] DEFAULT 0,
        [est_cost]            DECIMAL(12, 2) NOT NULL CONSTRAINT [DF_app_transport_legs_est_cost] DEFAULT 0,
        [created_by]          NVARCHAR(450)  NULL,
        CONSTRAINT [PK_app_transport_legs] PRIMARY KEY CLUSTERED ([id]),
        CONSTRAINT [CK_app_transport_legs_event] CHECK ([event] IN ('BOOKED', 'SWAPPED', 'REVISED', 'EXECUTED', 'PRESTART')),
        CONSTRAINT [CK_app_transport_legs_outcome] CHECK ([outcome] IN ('LOCAL', 'ABSORBED', 'BILLED')),
        CONSTRAINT [CK_app_transport_legs_origin_kind] CHECK ([origin_kind] IN ('PRIOR_JOB', 'GPS', 'SAME_ORDER', 'UNKNOWN'))
    );
    CREATE NONCLUSTERED INDEX [IX_app_transport_legs_booking]    ON [dbo].[app_transport_legs] ([booking_key]);
    CREATE NONCLUSTERED INDEX [IX_app_transport_legs_created]    ON [dbo].[app_transport_legs] ([created_at]);
    CREATE NONCLUSTERED INDEX [IX_app_transport_legs_hold_event] ON [dbo].[app_transport_legs] ([hold_id], [event]);
END;

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'app_deal_values' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    CREATE TABLE [dbo].[app_deal_values] (
        [id]                  NVARCHAR(36)   NOT NULL,
        [captured_at]         DATETIME2      NOT NULL CONSTRAINT [DF_app_deal_values_captured_at] DEFAULT SYSUTCDATETIME(),
        [event]               NVARCHAR(20)   NOT NULL,
        [sfdc_opportunity_id] NVARCHAR(18)   NULL,
        [booking_key]         NVARCHAR(100)  NULL,
        [client_name]         NVARCHAR(255)  NOT NULL CONSTRAINT [DF_app_deal_values_client_name] DEFAULT '',
        [app_quoted_total]    DECIMAL(14, 2) NULL,
        [sf_amount]           DECIMAL(14, 2) NULL,
        [sf_stage]            NVARCHAR(100)  NULL,
        [created_by]          NVARCHAR(450)  NULL,
        CONSTRAINT [PK_app_deal_values] PRIMARY KEY CLUSTERED ([id]),
        CONSTRAINT [CK_app_deal_values_event] CHECK ([event] IN ('BOOKED', 'REVISED', 'WON', 'AMOUNT_CHANGED'))
    );
    CREATE NONCLUSTERED INDEX [IX_app_deal_values_opportunity] ON [dbo].[app_deal_values] ([sfdc_opportunity_id], [captured_at]);
END;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- Expect: legs_exists 1, legs_columns 21, deals_exists 1, deals_columns 10, index_count 4.
SELECT
    (SELECT COUNT(*) FROM sys.tables  WHERE name = 'app_transport_legs')                     AS legs_exists,
    (SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('dbo.app_transport_legs')) AS legs_columns,
    (SELECT COUNT(*) FROM sys.tables  WHERE name = 'app_deal_values')                        AS deals_exists,
    (SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('dbo.app_deal_values'))    AS deals_columns,
    (SELECT COUNT(*) FROM sys.indexes WHERE name IN ('IX_app_transport_legs_booking', 'IX_app_transport_legs_created',
                                                     'IX_app_transport_legs_hold_event', 'IX_app_deal_values_opportunity')) AS index_count;

-- The Salesforce opportunities the app made (app_created_opportunities).
--
-- The app creates opportunities as its integration user, which is a real
-- person's Salesforce user, so Salesforce's Created By can't tell an
-- opportunity made in the app from one that person made by hand. The app
-- records each one it makes, so Ops can count the LED opportunities made
-- directly in Salesforce instead (lib/opportunityOrigins.ts, /ops/opportunities).
--
-- Run BEFORE deploying the code: Prisma reads the new model, and the booking
-- paths write to it (best-effort: a missing table is logged and the booking
-- goes ahead, but nothing is recorded until it exists).
-- Safe to re-run: guarded on the table. Adds a new table; no existing data touched.
-- No GO separators: works in sqlcmd, SSMS, Azure Data Studio or the portal.

IF OBJECT_ID('dbo.app_created_opportunities', 'U') IS NULL
    CREATE TABLE [dbo].[app_created_opportunities] (
        [sfdc_opportunity_id] NVARCHAR(18)  NOT NULL CONSTRAINT [PK_app_created_opportunities] PRIMARY KEY,
        [created_at]          DATETIME2     NOT NULL CONSTRAINT [DF_app_created_opportunities_created_at] DEFAULT SYSUTCDATETIME(),
        [created_by]          NVARCHAR(191) NULL,
        [path]                NVARCHAR(30)  NOT NULL
    );

-- Verify. Expected: created_table 1.
SELECT CASE WHEN OBJECT_ID('dbo.app_created_opportunities', 'U') IS NULL THEN 0 ELSE 1 END AS created_table;

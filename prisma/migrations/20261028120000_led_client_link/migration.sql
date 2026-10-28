-- Which LED client each Salesforce account is (step 2: the app sets up a won
-- deal's LED program, which belongs to an LED client).
--
-- LED's dbo.clients has no Salesforce link, and names don't line up (LED's
-- client is sometimes the agency, sometimes the brand), so staff pick the LED
-- client once per account on Reservations (lib/ledClients.ts). One row per
-- account: app_led_client_links.
--
-- Also the Salesforce account on each hold (app_holds.sfdc_account_id), read
-- from the opportunity by the reconcile every sweep, like the job number, so
-- Reservations can show whether a won booking's account is linked. Existing
-- holds are backfilled within 15 minutes of deploy.
--
-- Run BEFORE deploying the code: Prisma selects every column of app_holds, so
-- a deploy without it breaks every page that reads holds.
-- Safe to re-run: guarded on the column and the table. Adds a nullable column
-- and a new table; no existing data touched.
-- No GO separators: works in sqlcmd, SSMS, Azure Data Studio or the portal.

IF COL_LENGTH('dbo.app_holds', 'sfdc_account_id') IS NULL
    ALTER TABLE [dbo].[app_holds] ADD [sfdc_account_id] NVARCHAR(18) NULL;

IF OBJECT_ID('dbo.app_led_client_links', 'U') IS NULL
    CREATE TABLE [dbo].[app_led_client_links] (
        [sfdc_account_id] NVARCHAR(18)     NOT NULL CONSTRAINT [PK_app_led_client_links] PRIMARY KEY,
        [account_name]    NVARCHAR(255)    NOT NULL,
        [client_uid]      UNIQUEIDENTIFIER NOT NULL,
        [linked_by]       NVARCHAR(191)    NOT NULL,
        [linked_at]       DATETIME2        NOT NULL CONSTRAINT [DF_app_led_client_links_linked_at] DEFAULT SYSUTCDATETIME()
    );

-- Verify. Expected: hold_column 1, link_table 1.
SELECT
    CASE WHEN COL_LENGTH('dbo.app_holds', 'sfdc_account_id') IS NULL THEN 0 ELSE 1 END AS hold_column,
    CASE WHEN OBJECT_ID('dbo.app_led_client_links', 'U') IS NULL THEN 0 ELSE 1 END AS link_table;

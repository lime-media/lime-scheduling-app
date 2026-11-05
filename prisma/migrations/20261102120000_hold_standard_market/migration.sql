-- LED's standard market for each hold (app_holds.standard_market_uid →
-- dbo.standard_market_lookup.standard_market_uid).
--
-- A hold's market is free text. LED's standard market list is the one market
-- list: a CampaignIQ request market and an LED program market both carry a
-- standard_market_uid. The sweep sets it on every live hold from the market
-- text: a standard market by name, else the standard market whose area holds
-- the town (lib/standardMarkets.ts). NULL: not located (e.g. a Salesforce
-- "Multi-market: ..." label). Existing holds are filled within 15 minutes of
-- deploy.
--
-- Run BEFORE deploying the code: Prisma selects every column of app_holds, so
-- a deploy without it breaks every page that reads holds.
-- Safe to re-run: guarded on the column. Adds a nullable column; no existing
-- data touched.
-- No GO separators: works in sqlcmd, SSMS, Azure Data Studio or the portal.

IF COL_LENGTH('dbo.app_holds', 'standard_market_uid') IS NULL
    ALTER TABLE [dbo].[app_holds] ADD [standard_market_uid] UNIQUEIDENTIFIER NULL;

-- Verify. Expected: column_exists 1.
SELECT CASE WHEN COL_LENGTH('dbo.app_holds', 'standard_market_uid') IS NULL THEN 0 ELSE 1 END AS column_exists;

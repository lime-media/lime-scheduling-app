-- When the sweep moved a won hold onto the truck LED runs its job on and the
-- opportunity's LED Trucks hasn't reached Salesforce yet
-- (app_holds.led_follow_sync_pending). Once the hold is on LED's truck the
-- next sweep has nothing to move, so this is what retries the Salesforce sync
-- until it succeeds (lib/ledTruckFollow.ts syncFollowedOpportunities). NULL:
-- nothing waiting.
--
-- Run BEFORE deploying the code: Prisma selects every column of app_holds, so
-- a deploy without it breaks every page that reads holds.
-- Safe to re-run: guarded on the column. Adds a nullable column; no existing
-- data touched.
-- No GO separators: works in sqlcmd, SSMS, Azure Data Studio or the portal.

IF COL_LENGTH('dbo.app_holds', 'led_follow_sync_pending') IS NULL
    ALTER TABLE [dbo].[app_holds] ADD [led_follow_sync_pending] DATETIME2 NULL;

-- Verify. Expected: column_exists 1.
SELECT CASE WHEN COL_LENGTH('dbo.app_holds', 'led_follow_sync_pending') IS NULL THEN 0 ELSE 1 END AS column_exists;

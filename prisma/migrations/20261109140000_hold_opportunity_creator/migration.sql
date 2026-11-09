-- Who made each hold's Salesforce opportunity (Opportunity.CreatedById),
-- copied onto its holds by the reconcile every sweep, like the job number and
-- account. It tells the Leah Miles bot's opportunities apart from people's, so
-- they can be left out of what the app sends to LED (lib/sfdcBots.ts).
-- Live holds (HOLD, EXTENSION_REQUESTED, COMMITTED) are filled within 15 minutes
-- of deploy; released ones keep NULL (nothing reads them for this).
--
-- Run BEFORE deploying the code: Prisma selects every column of app_holds, so
-- a deploy without it breaks every page that reads holds.
-- Safe to re-run: guarded on the column. Adds a nullable column; no existing
-- data touched.
-- No GO separators: works in sqlcmd, SSMS, Azure Data Studio or the portal.

IF COL_LENGTH('dbo.app_holds', 'sfdc_created_by_id') IS NULL
    ALTER TABLE [dbo].[app_holds] ADD [sfdc_created_by_id] NVARCHAR(18) NULL;

-- Verify. Expected: creator_column 1.
SELECT CASE WHEN COL_LENGTH('dbo.app_holds', 'sfdc_created_by_id') IS NULL THEN 0 ELSE 1 END AS creator_column;

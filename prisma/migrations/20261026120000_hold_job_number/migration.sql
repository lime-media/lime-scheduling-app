-- The Salesforce job number on each hold (Opportunity.Job_Number__c).
--
-- A won deal gets a job number in Salesforce, and ops gives its LED program
-- the same one (dbo.client_programs.job_number). Storing it on the hold links
-- a committed reservation to its LED program: the conflict sweep stops
-- flagging a booking against its own program, and Reservations hides a
-- booking once LED has it scheduled (lib/ledJobs.ts). The opportunity
-- reconcile fills it in for every live hold on an opportunity, every sweep,
-- so existing holds are backfilled within 15 minutes of deploy.
--
-- Run BEFORE deploying the code: Prisma selects every column of app_holds, so
-- a deploy without it breaks every page that reads holds.
-- Safe to re-run: guarded on the column. Adds a nullable column; no existing
-- data touched.
-- No GO separators: works in sqlcmd, SSMS, Azure Data Studio or the portal.

IF COL_LENGTH('dbo.app_holds', 'sfdc_job_number') IS NULL
    ALTER TABLE [dbo].[app_holds] ADD [sfdc_job_number] NVARCHAR(50) NULL;

-- Verify. Expected: column_exists 1.
SELECT CASE WHEN COL_LENGTH('dbo.app_holds', 'sfdc_job_number') IS NULL THEN 0 ELSE 1 END AS column_exists;

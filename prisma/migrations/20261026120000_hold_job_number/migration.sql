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
-- Also the LED program's job number on each recorded conflict
-- (schedule_conflicts.scheduled_job_number): two LED programs can share a name
-- on one truck, and a conflict with each is its own problem, so the job number
-- is part of a conflict's identity (lib/scheduleCache.ts conflictKey). Rows
-- recorded before keep NULL and match on truck, program and dates as before.
--
-- Run BEFORE deploying the code: Prisma selects every column of app_holds, so
-- a deploy without it breaks every page that reads holds, and the conflict
-- sweep reads the new conflict column.
-- Safe to re-run (including after running the first version of this file,
-- which added only sfdc_job_number): guarded on each column. Adds nullable
-- columns; no existing data touched.
-- No GO separators: works in sqlcmd, SSMS, Azure Data Studio or the portal.

IF COL_LENGTH('dbo.app_holds', 'sfdc_job_number') IS NULL
    ALTER TABLE [dbo].[app_holds] ADD [sfdc_job_number] NVARCHAR(50) NULL;

IF COL_LENGTH('dbo.schedule_conflicts', 'scheduled_job_number') IS NULL
    ALTER TABLE [dbo].[schedule_conflicts] ADD [scheduled_job_number] NVARCHAR(100) NULL;

-- Verify. Expected: hold_column 1, conflict_column 1.
SELECT
    CASE WHEN COL_LENGTH('dbo.app_holds', 'sfdc_job_number') IS NULL THEN 0 ELSE 1 END AS hold_column,
    CASE WHEN COL_LENGTH('dbo.schedule_conflicts', 'scheduled_job_number') IS NULL THEN 0 ELSE 1 END AS conflict_column;

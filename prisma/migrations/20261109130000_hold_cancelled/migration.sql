-- A cancelled booking stays listed (lib/cancelBooking.ts). Cancel used to
-- delete the booking's holds, so it vanished from Reservations and the client
-- portal alike. Now its holds are marked EXPIRED and these record that it was
-- cancelled, by whom and why: Reservations and the portal show it under
-- Expired as Cancelled, with the reason, and Reinstate clears them.
--
-- Run BEFORE deploying the code: Prisma selects every column of app_holds, so
-- a deploy without them breaks every page that reads holds.
-- Safe to re-run: guarded on each column. Adds nullable columns; no existing
-- data touched.
-- No GO separators: works in sqlcmd, SSMS, Azure Data Studio or the portal.

IF COL_LENGTH('dbo.app_holds', 'cancelled_at') IS NULL
    ALTER TABLE [dbo].[app_holds] ADD [cancelled_at] DATETIME2 NULL;

IF COL_LENGTH('dbo.app_holds', 'cancel_reason') IS NULL
    ALTER TABLE [dbo].[app_holds] ADD [cancel_reason] NVARCHAR(1000) NULL;

IF COL_LENGTH('dbo.app_holds', 'cancelled_by') IS NULL
    ALTER TABLE [dbo].[app_holds] ADD [cancelled_by] NVARCHAR(191) NULL;

-- Verify. Expected: cancelled_at 1, cancel_reason 1, cancelled_by 1.
SELECT
    CASE WHEN COL_LENGTH('dbo.app_holds', 'cancelled_at')  IS NULL THEN 0 ELSE 1 END AS cancelled_at,
    CASE WHEN COL_LENGTH('dbo.app_holds', 'cancel_reason') IS NULL THEN 0 ELSE 1 END AS cancel_reason,
    CASE WHEN COL_LENGTH('dbo.app_holds', 'cancelled_by')  IS NULL THEN 0 ELSE 1 END AS cancelled_by;

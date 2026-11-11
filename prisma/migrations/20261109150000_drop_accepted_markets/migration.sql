-- Drops app_accepted_markets. DESTRUCTIVE (a table and its 50 rows).
--
-- It held the top 50 DMAs, used only to rank a market's impressions tier.
-- PR #145 moved that list into code (lib/pricing/topDmas.ts), checked equal
-- before this drop: the same 50 dma_codes, all active, unchanged since
-- 2026-08-31. Since then nothing reads the table (the model, its seed
-- script and seed SQL are removed in the same PR).
--
-- Run AFTER deploying the code: the deployed code no longer has the model.
-- (Run before, it is harmless too: nothing has read the table since #145.)
-- Safe to re-run: guarded on the table.
-- No GO separators: works in sqlcmd, SSMS, Azure Data Studio or the portal.

IF OBJECT_ID('dbo.app_accepted_markets', 'U') IS NOT NULL
    DROP TABLE [dbo].[app_accepted_markets];

-- Verify. Expected: accepted_markets_table 0.
SELECT CASE WHEN OBJECT_ID('dbo.app_accepted_markets', 'U') IS NULL THEN 0 ELSE 1 END AS accepted_markets_table;

-- One-time DATA backfill (no schema change).
--
-- Salesforce sends Hold Exp as a bare "yyyy-MM-dd", and that date is the LAST
-- day a hold is valid — the truck is only released the day after. The webhook
-- parsed it with `new Date(holdExp)`, which yields 00:00Z: the START of that
-- day. 20260901000000_merge_hold_requests_into_holds then copied those values
-- straight across (`SET expires_at = sfdc_hold_exp`), so every Salesforce row
-- carries an expiry a full calendar day early.
--
-- The application side is fixed in app/api/integrations/salesforce/hold/route.ts
-- (endOfDayUtc), which only affects new pushes. This corrects the existing rows.
--
-- Safe to re-run: after the first pass no SALESFORCE row has a 00:00:00 time,
-- so the UPDATE matches nothing.

-- ── Review first ─────────────────────────────────────────────────────────────
-- SELECT id, truck_number, client_name, status, expires_at
-- FROM dbo.app_holds
-- WHERE source = 'SALESFORCE'
--   AND expires_at IS NOT NULL
--   AND CAST(expires_at AS TIME) = '00:00:00';

-- ── Step 1: move midnight expiries to the end of the same day ────────────────
IF COL_LENGTH('dbo.app_holds', 'expires_at') IS NOT NULL
    UPDATE dbo.app_holds
    SET expires_at = DATEADD(MILLISECOND, -1, DATEADD(DAY, 1, CAST(expires_at AS DATE)))
    WHERE source = 'SALESFORCE'
      AND expires_at IS NOT NULL
      AND CAST(expires_at AS TIME) = '00:00:00';

-- ── Step 2 (OPTIONAL — review before running) ────────────────────────────────
-- Holds the sweep expired a day early. After step 1 their corrected expiry is
-- back in the future, but status is still EXPIRED so they stay released.
--
-- In practice this should match very little: the sweep ran on an in-process
-- node-cron timer that could not fire on Vercel, so few holds were ever
-- auto-expired at all. Check before you restore anything — some of these may
-- have been expired deliberately by ops, and reviving them re-blocks trucks.
--
-- SELECT h.id, h.truck_number, h.client_name, h.expires_at, h.status
-- FROM dbo.app_holds h
-- WHERE h.source = 'SALESFORCE'
--   AND h.status = 'EXPIRED'
--   AND h.expires_at > SYSUTCDATETIME()
--   AND EXISTS (
--         SELECT 1 FROM dbo.app_audit_logs a
--         WHERE a.hold_id = h.id AND a.action = 'EXPIRE_HOLD'
--   );
--
-- BEGIN TRAN;
-- UPDATE h
-- SET h.status = 'HOLD'
-- FROM dbo.app_holds h
-- WHERE h.source = 'SALESFORCE'
--   AND h.status = 'EXPIRED'
--   AND h.expires_at > SYSUTCDATETIME()
--   AND EXISTS (
--         SELECT 1 FROM dbo.app_audit_logs a
--         WHERE a.hold_id = h.id AND a.action = 'EXPIRE_HOLD'
--   );
-- -- verify, then COMMIT; or ROLLBACK;

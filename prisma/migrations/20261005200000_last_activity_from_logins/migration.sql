-- Last activity: count logins, and not the Salesforce service account.
--
-- The first backfill (20261005120000) only counted actions (holds, expiry
-- changes, chats), so people who logged in and only looked or quoted showed
-- an old date or "Never". Each successful login is a consumed row in
-- app_login_otps; use the latest one where it is more recent. The Salesforce
-- integration's service account is not a person: clear it.
--
-- Safe to re-run: only ever moves a date forward, or clears the service account.

UPDATE u SET last_active_at = l.last_login
FROM [dbo].[app_users] u
CROSS APPLY (SELECT MAX(consumed_at) AS last_login FROM [dbo].[app_login_otps] o WHERE o.user_id = u.id) l
WHERE l.last_login IS NOT NULL
  AND (u.last_active_at IS NULL OR l.last_login > u.last_active_at)
  AND u.email <> 'sfdc-integration@lime-media.com';

UPDATE [dbo].[app_users] SET last_active_at = NULL WHERE email = 'sfdc-integration@lime-media.com';

-- ── Verify ───────────────────────────────────────────────────────────────────
-- Expect: nobody shows a date older than their last login; the service account is NULL.
SELECT
    (SELECT COUNT(*) FROM [dbo].[app_users] u
       CROSS APPLY (SELECT MAX(consumed_at) AS last_login FROM [dbo].[app_login_otps] o WHERE o.user_id = u.id) l
       WHERE l.last_login > COALESCE(u.last_active_at, '1900-01-01')
         AND u.email <> 'sfdc-integration@lime-media.com')                                   AS older_than_last_login,
    (SELECT COUNT(*) FROM [dbo].[app_users] WHERE email = 'sfdc-integration@lime-media.com'
       AND last_active_at IS NOT NULL)                                                      AS service_account_active;

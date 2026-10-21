-- One-time login codes for the client portal (lib/clientOtp.ts).
--
-- The internal side already does this in dbo.app_login_otps, but that table's
-- user_id is a foreign key to dbo.app_users. Client users live in
-- dbo.app_client_users, so they get their own table rather than a nullable
-- FK on the internal one — nothing about internal login changes.
--
-- A code is stored bcrypt-hashed, never in the clear, and is good for one
-- login: it expires, counts attempts, and is marked consumed when used.
--
-- No foreign key on client_user_id, unlike app_login_otps → app_users.
-- dbo.app_client_users.id is NVARCHAR(1000); a referencing column has to match
-- that type exactly, and NVARCHAR(1000) is 2000 bytes — past the 1700-byte
-- limit for an index key, so the column could then not be indexed, which is
-- the one thing this table is read by. The id is stored as NVARCHAR(450)
-- instead (a cuid is 25 characters) and the link is kept in code. Rows are
-- harmless on their own: a code is useless without the account, expires in
-- ten minutes, and app/api/admin/client-users deletes them with the user.
--
-- Run BEFORE deploying the code (the client login flow reads this table; a
-- deploy without it locks every client out).
-- Safe to re-run: guarded on existence. New table; no existing data touched.
-- No GO separators: works in sqlcmd, SSMS, Azure Data Studio or the portal.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'app_client_login_otps' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    CREATE TABLE [dbo].[app_client_login_otps] (
        [id]             NVARCHAR(36)  NOT NULL,
        [client_user_id] NVARCHAR(450) NOT NULL,
        [code_hash]      NVARCHAR(255) NOT NULL,
        [expires_at]     DATETIME2     NOT NULL,
        [attempts]       INT           NOT NULL CONSTRAINT [DF_app_client_login_otps_attempts]   DEFAULT 0,
        [consumed_at]    DATETIME2     NULL,
        [created_at]     DATETIME2     NOT NULL CONSTRAINT [DF_app_client_login_otps_created_at] DEFAULT SYSUTCDATETIME(),
        CONSTRAINT [PK_app_client_login_otps] PRIMARY KEY CLUSTERED ([id])
    );
    -- Lookup is always "this client's newest unconsumed code".
    CREATE NONCLUSTERED INDEX [IX_app_client_login_otps_owner]
        ON [dbo].[app_client_login_otps] ([client_user_id], [consumed_at], [created_at] DESC);
END;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- Expect: table_exists 1, column_count 7, index_exists 1, without_email 0.
--
-- without_email is the one to stop on. A client with no email cannot be sent
-- a code, and there is no password-only path, so any count above zero is that
-- many clients who will not be able to log in once this deploys. Set their
-- addresses on the Users page (Client Users) and run this again before
-- deploying. The query below names them.
SELECT
    (SELECT COUNT(*) FROM sys.tables  WHERE name = 'app_client_login_otps')                      AS table_exists,
    (SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('dbo.app_client_login_otps'))  AS column_count,
    (SELECT COUNT(*) FROM sys.indexes WHERE name = 'IX_app_client_login_otps_owner')             AS index_exists,
    (SELECT COUNT(*) FROM dbo.app_client_users
      WHERE email IS NULL OR LTRIM(RTRIM(email)) = '')                                           AS without_email;

-- Who still needs an address — empty when the deploy is safe.
SELECT username, company_name
FROM dbo.app_client_users
WHERE email IS NULL OR LTRIM(RTRIM(email)) = ''
ORDER BY username;

-- ============================================================
-- Add Client AI Questions log — dbo.app_client_ai_questions
-- New migration (not a backfill) — a flat, client-wise log of every
-- question asked to the client-portal AI assistant (app/api/client/chat/*),
-- across all clients in one table.
--
-- This is deliberately separate from dbo.client_chat_conversations /
-- dbo.client_chat_messages (see 20260810000000_add_client_chat_tables),
-- which already store the same questions too, just joined through
-- conversation threading. This table exists for simple reporting/export
-- over "what are clients asking" without needing that join — written
-- alongside the existing chat persistence, not instead of it.
--
-- Depends on dbo.app_client_users already existing — run this AFTER
-- 20260706000000_add_client_users_and_hold_requests.
--
-- Run against Azure SQL using the same process as the other
-- prisma/*.sql scripts (see SETUP.md). Do NOT run via
-- `prisma db push` / `prisma migrate deploy`.
--
-- UAT ONLY for now — do not run this against limemediaprod yet.
-- ============================================================

IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'app_client_ai_questions'
)
BEGIN
    CREATE TABLE dbo.app_client_ai_questions (
        id             NVARCHAR(36)   NOT NULL,
        -- NVARCHAR(1000) to match dbo.app_client_users.id's actual width
        -- (see 20260810000000_add_client_chat_tables) — FK below requires
        -- an exact type/length match.
        client_user_id NVARCHAR(1000) NOT NULL,
        question       NVARCHAR(MAX)  NOT NULL,
        asked_at       DATETIME2      NOT NULL CONSTRAINT DF_app_client_ai_questions_asked_at DEFAULT GETUTCDATE(),

        CONSTRAINT PK_app_client_ai_questions PRIMARY KEY (id),
        CONSTRAINT FK_app_client_ai_questions_client_user
            FOREIGN KEY (client_user_id)
            REFERENCES dbo.app_client_users (id)
            ON DELETE NO ACTION
    );

    CREATE INDEX IX_app_client_ai_questions_client_user_id
        ON dbo.app_client_ai_questions (client_user_id);

    PRINT 'Created table: dbo.app_client_ai_questions';
END
ELSE
BEGIN
    PRINT 'Table already exists, skipping: dbo.app_client_ai_questions';
END

PRINT 'Client AI questions table migration complete.';

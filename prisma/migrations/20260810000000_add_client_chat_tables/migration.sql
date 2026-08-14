-- ============================================================
-- Add Client Portal AI Chat Persistence Tables
-- dbo.client_chat_conversations and dbo.client_chat_messages
-- back the client-portal AI assistant (app/api/client/chat/*).
--
-- CORRECTION (2026-08-11): this file's original comment claimed
-- these tables "do not yet exist anywhere" / are unreleased work.
-- That's false — direct introspection of live limemediaprod found
-- both tables already present with real rows (8 conversations, 30
-- messages) predating this migration file. Path unconfirmed (a
-- direct run against prod ahead of merge, or — more likely given
-- local dev connects straight to production — pre-merge testing
-- against the live DB). Treat this as a backfilled migration, not
-- a forward one: guarded/no-op wherever the tables already exist.
--
-- Mirrors dbo.chat_conversations / dbo.chat_messages (see
-- prisma/create-chat-tables.sql) but scoped to the client
-- portal: client_user_id instead of user_id, FK'd to
-- dbo.app_client_users instead of dbo.app_users. Kept as
-- separate tables (not a shared user_id/user_type column) to
-- keep internal staff and client conversations fully isolated.
--
-- Not a Prisma model — queried via raw SQL (lib/mssql.ts), not
-- the Prisma client, so there is no corresponding entry in
-- prisma/schema.prisma (same as the internal chat tables).
--
-- Depends on dbo.app_client_users already existing — run this
-- AFTER 20260706000000_add_client_users_and_hold_requests.
--
-- Run against Azure SQL using the same process as the other
-- prisma/*.sql scripts (see SETUP.md). Do NOT run via
-- `prisma db push` / `prisma migrate deploy`.
-- ============================================================

-- -------------------------------------------------------
-- client_chat_conversations: one row per chat session per
-- client user
-- -------------------------------------------------------
IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'client_chat_conversations'
)
BEGIN
    CREATE TABLE dbo.client_chat_conversations (
        id             NVARCHAR(36)   NOT NULL,
        title          NVARCHAR(255)  NOT NULL,
        -- NVARCHAR(1000) to match dbo.app_client_users.id as it actually
        -- exists in production (confirmed via direct introspection) — not
        -- NVARCHAR(36) as the 20260706000000 migration's comments claim.
        -- That migration's documented lengths don't match live production;
        -- see note there. FK below requires an exact type/length match.
        client_user_id NVARCHAR(1000) NOT NULL,
        created_at     DATETIME2     NOT NULL CONSTRAINT DF_client_chat_conversations_created_at DEFAULT GETUTCDATE(),
        updated_at     DATETIME2     NOT NULL CONSTRAINT DF_client_chat_conversations_updated_at DEFAULT GETUTCDATE(),

        CONSTRAINT PK_client_chat_conversations PRIMARY KEY (id),
        CONSTRAINT FK_client_chat_conversations_client_user
            FOREIGN KEY (client_user_id)
            REFERENCES dbo.app_client_users (id)
            ON DELETE NO ACTION
    );

    CREATE INDEX IX_client_chat_conversations_client_user_id
        ON dbo.client_chat_conversations (client_user_id);

    PRINT 'Created table: dbo.client_chat_conversations';
END
ELSE
BEGIN
    PRINT 'Table already exists, skipping: dbo.client_chat_conversations';
END

-- -------------------------------------------------------
-- client_chat_messages: individual messages within a
-- client-portal conversation
-- role: 'user' | 'assistant'
-- -------------------------------------------------------
IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'client_chat_messages'
)
BEGIN
    CREATE TABLE dbo.client_chat_messages (
        id              NVARCHAR(36)  NOT NULL,
        conversation_id NVARCHAR(36)  NOT NULL,
        role            NVARCHAR(20)  NOT NULL,
        content         NVARCHAR(MAX) NOT NULL,
        created_at      DATETIME2     NOT NULL CONSTRAINT DF_client_chat_messages_created_at DEFAULT GETUTCDATE(),

        CONSTRAINT PK_client_chat_messages PRIMARY KEY (id),
        CONSTRAINT FK_client_chat_messages_conversation
            FOREIGN KEY (conversation_id)
            REFERENCES dbo.client_chat_conversations (id)
            ON DELETE CASCADE
    );

    CREATE INDEX IX_client_chat_messages_conversation_id
        ON dbo.client_chat_messages (conversation_id);

    PRINT 'Created table: dbo.client_chat_messages';
END
ELSE
BEGIN
    PRINT 'Table already exists, skipping: dbo.client_chat_messages';
END

PRINT 'Client chat tables migration complete.';

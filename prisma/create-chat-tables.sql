-- ============================================================
-- Lime Media Scheduling Assistant — Chat Persistence Tables
-- Run ONCE against Azure SQL (limemediauat).
-- Safe to re-run: IF NOT EXISTS guards on every statement.
-- ============================================================

-- -------------------------------------------------------
-- chat_conversations: one row per chat session per user
-- -------------------------------------------------------
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='chat_conversations' AND xtype='U')
BEGIN
    CREATE TABLE dbo.chat_conversations (
        id         NVARCHAR(36)  NOT NULL,
        title      NVARCHAR(255) NOT NULL,
        user_id    NVARCHAR(36)  NOT NULL,
        created_at DATETIME2     NOT NULL CONSTRAINT DF_chat_conversations_created_at DEFAULT GETUTCDATE(),
        updated_at DATETIME2     NOT NULL CONSTRAINT DF_chat_conversations_updated_at DEFAULT GETUTCDATE(),

        CONSTRAINT PK_chat_conversations PRIMARY KEY (id),
        CONSTRAINT FK_chat_conversations_user
            FOREIGN KEY (user_id)
            REFERENCES dbo.app_users (id)
            ON DELETE NO ACTION
    );

    CREATE INDEX IX_chat_conversations_user_id
        ON dbo.chat_conversations (user_id);

    PRINT 'Created table: dbo.chat_conversations';
END
ELSE
BEGIN
    PRINT 'Table already exists, skipping: dbo.chat_conversations';
END

-- -------------------------------------------------------
-- chat_messages: individual messages within a conversation
-- role: 'user' | 'assistant'
-- -------------------------------------------------------
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='chat_messages' AND xtype='U')
BEGIN
    CREATE TABLE dbo.chat_messages (
        id              NVARCHAR(36)  NOT NULL,
        conversation_id NVARCHAR(36)  NOT NULL,
        role            NVARCHAR(20)  NOT NULL,
        content         NVARCHAR(MAX) NOT NULL,
        created_at      DATETIME2     NOT NULL CONSTRAINT DF_chat_messages_created_at DEFAULT GETUTCDATE(),

        CONSTRAINT PK_chat_messages PRIMARY KEY (id),
        CONSTRAINT FK_chat_messages_conversation
            FOREIGN KEY (conversation_id)
            REFERENCES dbo.chat_conversations (id)
            ON DELETE CASCADE
    );

    CREATE INDEX IX_chat_messages_conversation_id
        ON dbo.chat_messages (conversation_id);

    PRINT 'Created table: dbo.chat_messages';
END
ELSE
BEGIN
    PRINT 'Table already exists, skipping: dbo.chat_messages';
END

PRINT 'Done. Chat tables ready.';

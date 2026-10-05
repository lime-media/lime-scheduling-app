-- Link the staff chats logged by PR #100's code (deployed 2026-10-05 19:13 UTC,
-- replaced by PR #102 at ~21:45 UTC) to their conversations. That code did not
-- record the conversation id; PR #102 does. Each row is matched to the same
-- person's question with the same opening text, asked in the 10 minutes before
-- the usage row (production dry run: 5 rows, 8–20 seconds apart, each unique).
--
-- Safe to re-run: only rows still unlinked are touched.

UPDATE g SET conversation_id = m.conversation_id
FROM [dbo].[app_usage_log] g
CROSS APPLY (
    SELECT TOP 1 x.conversation_id
    FROM [dbo].[chat_messages] x
    JOIN [dbo].[chat_conversations] c ON c.id = x.conversation_id
    WHERE c.user_id = g.actor_id AND c.actor_type = 'app_user' AND x.role = 'user'
      AND x.created_at BETWEEN DATEADD(MINUTE, -10, g.created_at) AND g.created_at
      AND LEFT(x.content, 100) = LEFT(JSON_VALUE(g.inputs, '$.message'), 100)
    ORDER BY x.created_at DESC
) m
WHERE g.tool = 'ai_chat_staff' AND g.conversation_id IS NULL;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- Expect: 0.
SELECT COUNT(*) AS staff_chats_unlinked FROM [dbo].[app_usage_log] WHERE tool = 'ai_chat_staff' AND conversation_id IS NULL;

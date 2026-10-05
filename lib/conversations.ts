/**
 * Conversations: the CONTENT of AI chats — staff (internal AI Assistant) and
 * client (portal) alike — in chat_conversations / chat_messages, marked by
 * actor_type. This is where chat text lives, with its own access and its own
 * deletion; the usage log only records that a chat happened and links here by
 * conversation id (lib/usageLog.ts).
 *
 * Every lookup names the owner AND the owner type, so a staff member's history
 * can never list a client's conversation, or the reverse.
 */

import { query } from '@/lib/mssql'

export type Party = { actorType: 'app_user' | 'client_user'; userId: string }
export type Message = { role: 'user' | 'assistant'; content: string }

/**
 * The conversation to write to: the one asked for if it is this party's, else
 * a new one titled from the first message. null if the store is unreachable —
 * the chat still answers, it just is not kept.
 */
export async function openConversation(party: Party, requestedId: string | null | undefined, firstMessage: string): Promise<string | null> {
  try {
    if (requestedId) {
      const [own] = await query<{ id: string }[]>(
        `SELECT id FROM dbo.chat_conversations WHERE id = @id AND user_id = @userId AND actor_type = @actorType`,
        { id: requestedId, userId: party.userId, actorType: party.actorType },
      )
      if (own) return String(own.id)
    }
    const [created] = await query<{ id: string }[]>(
      `INSERT INTO dbo.chat_conversations (id, title, user_id, actor_type, created_at, updated_at)
       OUTPUT INSERTED.id
       VALUES (NEWID(), @title, @userId, @actorType, GETUTCDATE(), GETUTCDATE())`,
      { title: firstMessage.slice(0, 60) || 'Conversation', userId: party.userId, actorType: party.actorType },
    )
    return created ? String(created.id) : null
  } catch (err) {
    console.error('[conversations] could not open a conversation:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Append messages in order and touch the conversation. Never throws. */
export async function addMessages(conversationId: string | null, messages: Message[]): Promise<void> {
  if (!conversationId) return
  try {
    for (const m of messages) {
      if (!m.content) continue
      await query(
        `INSERT INTO dbo.chat_messages (id, conversation_id, role, content, created_at)
         VALUES (NEWID(), @conversationId, @role, @content, GETUTCDATE())`,
        { conversationId, role: m.role, content: m.content },
      )
    }
    await query(`UPDATE dbo.chat_conversations SET updated_at = GETUTCDATE() WHERE id = @conversationId`, { conversationId })
  } catch (err) {
    console.error('[conversations] could not save messages:', err instanceof Error ? err.message : err)
  }
}

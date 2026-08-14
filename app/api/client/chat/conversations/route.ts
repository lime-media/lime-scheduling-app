import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/mssql'
import { getClientSession } from '@/lib/clientAuth'

export async function GET(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Staged rollout — see app/api/client/chat/route.ts
  if (session.username !== 'testclient') return NextResponse.json({ error: 'Not available yet' }, { status: 403 })

  const rows = await query<Record<string, unknown>[]>(
    `SELECT c.id, c.title, c.updated_at,
       (SELECT COUNT(*) FROM dbo.client_chat_messages m WHERE m.conversation_id = c.id) AS message_count
     FROM dbo.client_chat_conversations c
     WHERE c.client_user_id = @clientId
     ORDER BY c.updated_at DESC`,
    { clientId: session.id }
  )

  return NextResponse.json({ conversations: rows })
}

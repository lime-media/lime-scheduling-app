import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/mssql'
import { getClientSession } from '@/lib/clientAuth'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Ownership check — a client can only ever load their OWN conversation, never one they
  // guess/increment. This is the same isolation guarantee as every other /api/client route.
  const [conv] = await query<Record<string, unknown>[]>(
    `SELECT id, title, updated_at FROM dbo.client_chat_conversations WHERE id = @id AND client_user_id = @clientId`,
    { id: params.id, clientId: session.id }
  )
  if (!conv) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const messages = await query<Record<string, unknown>[]>(
    `SELECT id, role, content, created_at
     FROM dbo.client_chat_messages
     WHERE conversation_id = @convId
     ORDER BY created_at ASC`,
    { convId: params.id }
  )

  return NextResponse.json({ conversation: conv, messages })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [conv] = await query<Record<string, unknown>[]>(
    `SELECT id FROM dbo.client_chat_conversations WHERE id = @id AND client_user_id = @clientId`,
    { id: params.id, clientId: session.id }
  )
  if (!conv) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // No ON DELETE CASCADE on this FK (unlike some other tables) — delete messages first.
  await query(`DELETE FROM dbo.client_chat_messages WHERE conversation_id = @id`, { id: params.id })
  await query(`DELETE FROM dbo.client_chat_conversations WHERE id = @id`, { id: params.id })

  return NextResponse.json({ ok: true })
}

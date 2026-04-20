import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { query } from '@/lib/mssql'

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [conv] = await query<Record<string, unknown>[]>(
    `SELECT id, title, updated_at FROM dbo.chat_conversations WHERE id = @id AND user_id = @userId`,
    { id: params.id, userId: session.user.id }
  )
  if (!conv) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const messages = await query<Record<string, unknown>[]>(
    `SELECT id, role, content, created_at
     FROM dbo.chat_messages
     WHERE conversation_id = @convId
     ORDER BY created_at ASC`,
    { convId: params.id }
  )

  return NextResponse.json({ conversation: conv, messages })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify ownership before deleting
  const [conv] = await query<Record<string, unknown>[]>(
    `SELECT id FROM dbo.chat_conversations WHERE id = @id AND user_id = @userId`,
    { id: params.id, userId: session.user.id }
  )
  if (!conv) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // CASCADE on FK handles deleting chat_messages automatically
  await query(
    `DELETE FROM dbo.chat_conversations WHERE id = @id`,
    { id: params.id }
  )

  return NextResponse.json({ ok: true })
}

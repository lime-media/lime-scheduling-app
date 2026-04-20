import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { query } from '@/lib/mssql'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rows = await query<Record<string, unknown>[]>(
    `SELECT c.id, c.title, c.updated_at,
       (SELECT COUNT(*) FROM dbo.chat_messages m WHERE m.conversation_id = c.id) AS message_count
     FROM dbo.chat_conversations c
     WHERE c.user_id = @userId
     ORDER BY c.updated_at DESC`,
    { userId: session.user.id }
  )

  return NextResponse.json({ conversations: rows })
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { title } = await req.json()
  if (!title) return NextResponse.json({ error: 'Title required' }, { status: 400 })

  const [newConv] = await query<Record<string, unknown>[]>(
    `INSERT INTO dbo.chat_conversations (id, title, user_id, created_at, updated_at)
     OUTPUT INSERTED.id, INSERTED.title, INSERTED.created_at
     VALUES (NEWID(), @title, @userId, GETUTCDATE(), GETUTCDATE())`,
    { title: String(title).slice(0, 255), userId: session.user.id }
  )

  return NextResponse.json(newConv, { status: 201 })
}

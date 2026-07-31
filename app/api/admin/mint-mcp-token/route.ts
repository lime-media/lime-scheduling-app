import { NextRequest, NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { prisma } from '@/lib/prisma'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'

const VALID_USER_TYPES = ['app_user', 'client_user'] as const

export async function POST(req: NextRequest) {
  const keyError = validateInternalApiKey(req)
  if (keyError) return keyError

  const body = await req.json()
  const { user_id, label, user_type } = body

  if (!user_id || !label || !user_type) {
    return NextResponse.json(
      { error: 'Missing required fields: user_id, label, user_type' },
      { status: 400 }
    )
  }

  if (!VALID_USER_TYPES.includes(user_type)) {
    return NextResponse.json(
      { error: 'user_type must be "app_user" or "client_user"' },
      { status: 400 }
    )
  }

  // Verify user exists in the appropriate table
  let email: string

  if (user_type === 'app_user') {
    const user = await prisma.user.findUnique({ where: { id: user_id } })
    if (!user) {
      return NextResponse.json({ error: `No app_user found with id "${user_id}"` }, { status: 404 })
    }
    email = user.email
  } else {
    const clientUser = await prisma.clientUser.findUnique({ where: { id: user_id } })
    if (!clientUser) {
      return NextResponse.json({ error: `No client_user found with id "${user_id}"` }, { status: 404 })
    }
    email = clientUser.username
  }

  const rawToken = `mcp_${crypto.randomBytes(32).toString('hex')}`
  const tokenHash = await bcrypt.hash(rawToken, 12)

  const record = await prisma.mcpToken.create({
    data: {
      token_hash: tokenHash,
      user_id,
      user_type,
      label,
    },
  })

  return NextResponse.json({
    token_id: record.id,
    user_id,
    email,
    label,
    raw_token: rawToken,
  })
}

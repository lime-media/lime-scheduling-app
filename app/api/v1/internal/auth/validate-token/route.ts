import { NextRequest, NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { prisma } from '@/lib/prisma'
import bcrypt from 'bcryptjs'

export async function POST(req: NextRequest) {
  const keyError = validateInternalApiKey(req)
  if (keyError) return keyError

  // The user's MCP token is in a second Authorization-like header.
  // The MCP server forwards it as X-MCP-Token.
  const mcpToken = req.headers.get('x-mcp-token')
  if (!mcpToken) {
    return NextResponse.json({ error: 'Missing X-MCP-Token header' }, { status: 401 })
  }

  // Look up all non-revoked tokens and compare hashes
  const tokens = await prisma.mcpToken.findMany({
    where: { revoked_at: null },
  })

  for (const record of tokens) {
    const match = await bcrypt.compare(mcpToken, record.token_hash)
    if (!match) continue

    const userType = record.user_type || 'app_user'

    // Look up user from the correct table based on user_type
    if (userType === 'client_user') {
      const clientUser = await prisma.clientUser.findUnique({ where: { id: record.user_id } })
      if (!clientUser) {
        return NextResponse.json({ error: 'Token references a deleted client user' }, { status: 401 })
      }
      return NextResponse.json({
        user_id: clientUser.id,
        user_type: 'client_user',
        username: clientUser.username,
        company_name: clientUser.company_name,
        label: record.label,
        token_id: record.id,
      })
    } else {
      const user = await prisma.user.findUnique({ where: { id: record.user_id } })
      if (!user) {
        return NextResponse.json({ error: 'Token references a deleted user' }, { status: 401 })
      }
      return NextResponse.json({
        user_id: user.id,
        user_type: 'app_user',
        email: user.email,
        name: user.name,
        label: record.label,
        token_id: record.id,
      })
    }
  }

  return NextResponse.json({ error: 'Invalid or revoked token' }, { status: 401 })
}

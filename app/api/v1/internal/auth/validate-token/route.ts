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
    include: { user: { select: { id: true, email: true, name: true } } },
  })

  for (const record of tokens) {
    const match = await bcrypt.compare(mcpToken, record.token_hash)
    if (match) {
      return NextResponse.json({
        user_id: record.user.id,
        email: record.user.email,
        label: record.label,
        token_id: record.id,
      })
    }
  }

  return NextResponse.json({ error: 'Invalid or revoked token' }, { status: 401 })
}

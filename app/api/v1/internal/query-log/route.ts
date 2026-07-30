import { NextRequest, NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { prisma } from '@/lib/prisma'

export async function POST(req: NextRequest) {
  const keyError = validateInternalApiKey(req)
  if (keyError) return keyError

  const body = await req.json()
  const { user_id, token_id, tool_name, request_params, response_summary, outcome, latency_ms } = body

  if (!tool_name || !outcome || latency_ms === undefined) {
    return NextResponse.json(
      { error: 'Missing required fields: tool_name, outcome, latency_ms' },
      { status: 400 }
    )
  }

  const entry = await prisma.mcpQueryLog.create({
    data: {
      user_id: user_id || null,
      token_id: token_id || null,
      tool_name,
      request_params: request_params ? JSON.stringify(request_params) : null,
      response_summary: response_summary ? JSON.stringify(response_summary) : null,
      outcome,
      latency_ms,
    },
  })

  return NextResponse.json({ id: entry.id }, { status: 201 })
}

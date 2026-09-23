/**
 * Shared HTTP handling for the planner routes: auth, and turning Claude
 * failures into messages a rep can act on.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import Anthropic from '@anthropic-ai/sdk'
import { ClaudeUnavailableError } from './claude'

export async function requireStaff(req: NextRequest): Promise<NextResponse | null> {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  return token ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

export function claudeErrorResponse(err: unknown, context: string): NextResponse {
  if (err instanceof ClaudeUnavailableError) {
    return NextResponse.json({ error: 'Claude is not configured on this deployment (ANTHROPIC_API_KEY is missing).' }, { status: 503 })
  }
  if (err instanceof Anthropic.RateLimitError) {
    return NextResponse.json({ error: 'Claude is rate-limited right now. Try again in a minute.' }, { status: 429 })
  }
  if (err instanceof Anthropic.APIError) {
    console.error(`[plan/${context}] Claude API error ${err.status}:`, err.message)
    return NextResponse.json({ error: `Claude could not complete the request (${err.status ?? 'network'}).` }, { status: 502 })
  }
  console.error(`[plan/${context}] failed:`, err)
  return NextResponse.json({ error: err instanceof Error ? err.message : 'Request failed.' }, { status: 500 })
}

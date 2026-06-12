import { NextResponse } from 'next/server'

/**
 * Validates the Authorization: Bearer <key> header against the INTERNAL_API_KEY env var.
 * Returns null if valid, or a 401 NextResponse if invalid.
 */
export function validateInternalApiKey(request: Request): NextResponse | null {
  const apiKey = process.env.INTERNAL_API_KEY
  if (!apiKey) {
    console.error('[internal-auth] INTERNAL_API_KEY env var is not set')
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 })
  }

  const token = authHeader.slice(7)
  if (token !== apiKey) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 })
  }

  return null
}

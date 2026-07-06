import { NextRequest, NextResponse } from 'next/server'
import { getClientSession } from '@/lib/clientAuth'

export async function GET(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ user: null })
  return NextResponse.json({ user: session })
}

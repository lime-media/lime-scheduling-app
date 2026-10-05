/** POST /api/client/activity — a client is using the portal (Users page "Last activity"). */
import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { clientActor, touchActivity } from '@/lib/usageLog'

export async function POST(req: NextRequest) {
  const actor = clientActor(req)
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  waitUntil(touchActivity(actor))
  return new NextResponse(null, { status: 204 })
}

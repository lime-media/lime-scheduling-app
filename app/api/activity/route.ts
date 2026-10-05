/** POST /api/activity — a staff user is using the app (Users page "Last activity"). */
import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { staffActor, touchActivity } from '@/lib/usageLog'

export async function POST(req: NextRequest) {
  const actor = await staffActor(req)
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  waitUntil(touchActivity(actor))
  return new NextResponse(null, { status: 204 })
}

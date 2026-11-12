/**
 * POST /api/ops/led-requests/send  { bookingKey }
 *
 * Send one Ready booking to LED as a campaign request (lib/coreSend.ts).
 * Sending again returns the request LED already has. Off unless
 * CORE_SEND_ENABLED is "true" and Core is configured. Any signed-in staff user.
 */

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { liveSendDeps, sendBookingToCore } from '@/lib/coreSend'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null) as { bookingKey?: unknown } | null
  const bookingKey = typeof body?.bookingKey === 'string' ? body.bookingKey.trim() : ''
  if (!bookingKey) return NextResponse.json({ error: 'bookingKey is required.' }, { status: 400 })

  try {
    const r = await sendBookingToCore(bookingKey, liveSendDeps(session.user.id))
    return NextResponse.json(r.body, { status: r.status })
  } catch (err) {
    console.error('[led-requests/send] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: "The booking couldn't be sent. Try again shortly." }, { status: 502 })
  }
}

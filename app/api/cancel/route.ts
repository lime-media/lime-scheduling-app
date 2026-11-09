import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { EXTEND_STALE_MESSAGE, readCancelToken } from '@/lib/extendLink'
import { cancelBooking } from '@/lib/cancelBooking'

/**
 * POST /api/cancel  { token, reason? }
 *
 * The Cancel link in the expiry reminder email (lib/holdExpiryWarnings.ts),
 * confirmed on app/cancel. No sign-in: the signed token (lib/extendLink.ts,
 * signed for cancelling) is the rep's permission for this one booking, until
 * the expiry it warned about. Cancels the whole booking as Cancel on
 * Reservations does (lib/cancelBooking.ts). Public in middleware.ts;
 * authenticated by the token.
 */
export async function POST(request: Request) {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) return NextResponse.json({ error: 'Cancelling from email is not set up.' }, { status: 500 })

  const body = await request.json().catch(() => null) as { token?: unknown; reason?: unknown } | null
  const claims = typeof body?.token === 'string' ? readCancelToken(body.token, secret) : null
  if (!claims) return NextResponse.json({ error: "This link has expired or isn't valid. Cancel the reservation on Reservations instead." }, { status: 401 })

  const [hold, user] = await Promise.all([
    prisma.hold.findUnique({ where: { id: claims.holdId } }),
    prisma.user.findUnique({ where: { id: claims.userId }, select: { id: true } }),
  ])
  if (!hold || !user) return NextResponse.json({ error: 'This reservation no longer exists.' }, { status: 404 })
  if (hold.created_by !== user.id) return NextResponse.json({ error: "This link isn't for this reservation." }, { status: 403 })
  // The email's booking as it was warned about: once its expiry has moved
  // (extended, or changed on Reservations), this email no longer describes it.
  if (hold.expires_at?.toISOString() !== claims.expiresAt) {
    return NextResponse.json({ error: EXTEND_STALE_MESSAGE }, { status: 409 })
  }

  const r = await cancelBooking({ hold, userId: user.id, reason: body?.reason, via: 'expiry_email' })
  return NextResponse.json(r.body, { status: r.status })
}

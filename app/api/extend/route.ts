import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { centralDate } from '@/lib/dateOnly'
import { setBookingExpiry } from '@/lib/bookingExpiry'
import { addDays, isExtendDays, readExtendToken } from '@/lib/extendLink'

/**
 * POST /api/extend  { token, days }
 *
 * The Extend button in the expiry reminder email (lib/holdExpiryWarnings.ts),
 * confirmed on app/extend. No sign-in: the signed token (lib/extendLink.ts)
 * is the rep's permission for this one booking, until the expiry it warned
 * about. Moves the booking's one expiry `days` (1 or 2) past that date, with
 * every rule an expiry edit on Reservations has (lib/bookingExpiry.ts).
 * Public in middleware.ts; authenticated by the token.
 */
export async function POST(request: Request) {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) return NextResponse.json({ error: 'Extending from email is not set up.' }, { status: 500 })

  const body = await request.json().catch(() => null) as { token?: unknown; days?: unknown } | null
  const claims = typeof body?.token === 'string' ? readExtendToken(body.token, secret) : null
  if (!claims) return NextResponse.json({ error: "This link has expired or isn't valid. Extend the reservation on Reservations instead." }, { status: 401 })
  if (!isExtendDays(body?.days)) return NextResponse.json({ error: 'days must be 1 or 2' }, { status: 400 })

  const [hold, user] = await Promise.all([
    prisma.hold.findUnique({ where: { id: claims.holdId } }),
    prisma.user.findUnique({ where: { id: claims.userId }, select: { id: true } }),
  ])
  if (!hold || !user) return NextResponse.json({ error: 'This reservation no longer exists.' }, { status: 404 })
  if (hold.created_by !== user.id) return NextResponse.json({ error: "This link isn't for this reservation." }, { status: 403 })
  // One extension per email: once the expiry has moved (this link, another
  // click, or someone on Reservations), the next reminder brings a new link.
  if (hold.expires_at?.toISOString() !== claims.expiresAt) {
    return NextResponse.json({ error: 'This reservation has already been extended or changed. The next reminder will have a new link, or change it on Reservations.' }, { status: 409 })
  }

  const date = addDays(centralDate(new Date(claims.expiresAt)), body!.days as number)
  const r = await setBookingExpiry({ hold, date, userId: user.id, via: 'expiry_email', expectExpiresAt: claims.expiresAt })
  return NextResponse.json(r.status === 200 ? { ...r.body, date } : r.body, { status: r.status })
}

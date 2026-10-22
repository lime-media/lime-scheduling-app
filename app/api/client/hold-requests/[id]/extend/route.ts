import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getClientSession } from '@/lib/clientAuth'
import { sendAssistanceRequestEmail } from '@/lib/email'
import { bookingCapStarts, bookingKey, clientExtendRefusal } from '@/lib/bookings'
import { loadBookingHolds } from '@/lib/bookingLoad'
import { lastExpiryDate } from '@/lib/holdExpiry'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'
import { syncOpportunityLedWindow } from '@/lib/sfdcBooking'
import { holdReservesNow } from '@/lib/holdFilters'
import { HoldClashError, HoldLockTimeoutError, writeHoldsExclusive } from '@/lib/holdWriteLock'
import { centralDate, endOfDayCentral, holdExpDate } from '@/lib/dateOnly'

/**
 * POST /api/client/hold-requests/[id]/extend
 *
 * A client asks to extend a booking to a date. A booking is one quote, so the
 * request covers the WHOLE booking the hold belongs to (lib/bookings.ts
 * bookingKey): every one of the client's holds in it, every market and truck.
 *
 * - Refused unless every live hold is an ordinary reservation
 *   (clientExtendRefusal): not a confirmed (Closed Won) booking, not an
 *   expired one, not one with a request already waiting.
 * - The date may be no later than the client's limit: 3 days before the
 *   booking's first start (lastExpiryDate, the default runway). Later is a
 *   400 naming the limit, never quietly cut back. Staff approving may still
 *   give up to 2 days (app/api/hold-requests/[id]).
 * - While the request waits, the booking stays held until the date asked
 *   (its expiry is set to that date's end, which the limit keeps no later than
 *   3 days before the start): the sweep never releases a booking a client is
 *   still waiting on, and an unanswered request lapses at that date at the
 *   latest. Staff approve (the booking gets that date, capped at their limit)
 *   or deny (the booking is released).
 * - Status, date, reason and the audit row land in one transaction; the team
 *   gets ONE email for the booking.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { reason, extend_until } = await req.json().catch(() => ({ reason: '', extend_until: '' }))

  if (typeof extend_until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(extend_until)) {
    return NextResponse.json({ error: 'extend_until date is required (YYYY-MM-DD)' }, { status: 400 })
  }
  const extendDate = endOfDayCentral(extend_until)
  if (isNaN(extendDate.getTime())) {
    return NextResponse.json({ error: 'Invalid extend_until date' }, { status: 400 })
  }
  if (extendDate <= new Date()) {
    return NextResponse.json({ error: 'Extension date must be in the future' }, { status: 400 })
  }

  const hold = await prisma.hold.findUnique({ where: { id } })
  if (!hold || hold.client_user_id !== session.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // The whole booking, as far as it is this client's.
  const key = bookingKey(hold)
  const ids = key ? (await loadBookingHolds(key)).map(h => h.id) : [hold.id]
  const holds = (await prisma.hold.findMany({ where: { id: { in: ids.includes(hold.id) ? ids : [...ids, hold.id] } } }))
    .filter(h => h.client_user_id === session.id)

  const refusal = clientExtendRefusal(holds)
  if (refusal) return NextResponse.json({ error: refusal }, { status: 400 })

  const held = holds.filter(h => h.status === 'HOLD')
  const today = centralDate(new Date())
  const starts = bookingCapStarts(held.map(h => ({ start_date: h.start_date.toISOString().slice(0, 10), status: h.status })), today)
  const lastDate = lastExpiryDate([...starts].sort()[0])
  if (extend_until > lastDate) {
    return NextResponse.json({
      error: `The latest this booking can be held is ${lastDate}: 3 days before it starts.`,
      lastDate,
    }, { status: 400 })
  }
  const currentExpiry = held.map(h => h.expires_at).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0]
  if (currentExpiry && (extendDate <= currentExpiry || extend_until <= holdExpDate(currentExpiry))) {
    return NextResponse.json({ error: `This booking is already held until ${holdExpDate(currentExpiry)}. Choose a later date.` }, { status: 400 })
  }

  // The audit row's user is a staff record (FK to app_users); a client has
  // none, so the service user stands in, as for client holds.
  const serviceUser = await prisma.user.findFirst({ where: { email: SFDC_SERVICE_USER_EMAIL }, select: { id: true } })

  // Holds whose expiry has passed but the sweep hasn't reached yet reserve
  // nothing: moving their expiry to the date asked brings them back, and their
  // trucks may have been booked since. Written under those trucks' locks and
  // re-checked (lib/holdWriteLock.ts); this booking's own holds don't count.
  // A clash never names who holds the truck.
  const now = new Date()
  const lapsed = held.filter(h => !holdReservesNow(h, now) && h.end_date.toISOString().slice(0, 10) >= today)
  try {
    await writeHoldsExclusive(lapsed.map(h => ({ truck: h.truck_number, start: h.start_date.toISOString().slice(0, 10), end: h.end_date.toISOString().slice(0, 10) })), async tx => {
      await tx.hold.updateMany({
        where: { id: { in: held.map(h => h.id) }, status: 'HOLD' },
        data: {
          status: 'EXTENSION_REQUESTED',
          extension_reason: reason || null,
          extension_until: extendDate,
          // Held until the date asked while staff decide (see above).
          expires_at: extendDate,
        },
      })
      await tx.auditLog.create({
        data: {
          action:       'REQUEST_HOLD_EXTENSION',
          truck_number: held[0].truck_number,
          user_id:      serviceUser?.id ?? held[0].created_by,
          hold_id:      held[0].id,
          details:      JSON.stringify({
            booking: key, client: session.companyName, client_user_id: session.id,
            holds: held.map(h => h.id), extend_until: extend_until, reason: reason || null,
            was_expires_at: currentExpiry?.toISOString() ?? null,
          }),
        },
      })
    }, { ignoreHoldIds: [...ids, hold.id] })
  } catch (err) {
    if (err instanceof HoldClashError) {
      return NextResponse.json({ error: 'This booking has lapsed and some of its trucks have since been booked, so it can no longer be extended. Request a new quote.' }, { status: 409 })
    }
    if (err instanceof HoldLockTimeoutError) return NextResponse.json({ error: err.message }, { status: 409 })
    throw err
  }

  const markets = [...new Set(held.map(h => h.market))]
  const trucks = [...new Set(held.map(h => h.truck_number))]
  await sendAssistanceRequestEmail({
    companyName: session.companyName,
    market:      markets.join(', '),
    startDate:   held.map(h => h.start_date.toISOString().slice(0, 10)).sort()[0],
    endDate:     held.map(h => h.end_date.toISOString().slice(0, 10)).sort().reverse()[0],
    details:     `Hold extension requested for the whole booking: ${trucks.length} truck${trucks.length === 1 ? '' : 's'} (${trucks.join(', ')}) across ${markets.length} market${markets.length === 1 ? '' : 's'}. Extend until: ${extend_until}.${reason ? ` Reason: ${reason}` : ''} Approve or deny it on Reservations.`,
  }).catch((e) => console.error('[hold-extend] email failed:', e))

  // The request holds the booking to the date asked, so Salesforce's Hold Exp
  // follows (lib/sfdcBooking.ts syncOpportunityLedWindow). Logged for staff,
  // not shown to the client.
  const sfdcWarning = await syncOpportunityLedWindow(held.find(h => h.sfdc_opportunity_id)?.sfdc_opportunity_id ?? null)
  if (sfdcWarning) console.warn(`[hold-extend] ${sfdcWarning}`)

  return NextResponse.json({ ok: true, holds: held.length, extend_until })
}

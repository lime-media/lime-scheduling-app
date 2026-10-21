import { NextRequest, NextResponse } from 'next/server'
import type { Hold } from '@prisma/client'
import { reinstateBlockedByRelease } from '@/lib/attSoftRules'
import { QUOTE_ONLY_ORIGINATION } from '@/lib/quoteOnly'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere, holdReservesNow } from '@/lib/holdFilters'
import { DEFAULT_HOLD_DAYS, STAFF_MIN_DAYS_BEFORE_START, bookingHoldExpiry, lastExpiryDate } from '@/lib/holdExpiry'
import { NOTHING_TO_REINSTATE, bookingCapStarts, bookingKey, closedWonRefusal, reinstatableHolds, reinstateRefusal } from '@/lib/bookings'
import { loadBookingHolds } from '@/lib/bookingLoad'
import { closeOpportunityAsLost, getOpportunityStage } from '@/lib/sfdcOpportunityReconcile'
import { closedOpportunityBlocksReactivation, expiryClosesOpportunity, reactivationDecision, reopenQuestion } from '@/lib/sfdcIntegration'
import { reopenClosedLostOpportunity, syncOpportunityLedWindow } from '@/lib/sfdcBooking'
import { sendCancellationEmail, sendExtensionDecisionEmail } from '@/lib/email'
import { recordSwap } from '@/lib/transportMetricsRecord'
import { waitUntil } from '@vercel/functions'

type Action = 'swap_truck' | 'cancel_notify' | 'approve_extension' | 'deny_extension' | 'update_expiration' | 'reinstate'

// The status of the hold the request names. Committed (Closed Won) allows a
// truck swap only: cancel, expiry edits and everything else on a won deal are
// changed in Salesforce (lib/bookings.ts closedWonRefusal).
const VALID_FROM: Record<Action, string[]> = {
  swap_truck:         ['HOLD', 'COMMITTED'],
  cancel_notify:      ['HOLD', 'EXTENSION_REQUESTED'],
  approve_extension:  ['EXTENSION_REQUESTED'],
  deny_extension:     ['EXTENSION_REQUESTED'],
  update_expiration:  ['HOLD', 'EXTENSION_REQUESTED'],
  reinstate:          ['EXPIRED'],
}

type HoldWithClient = Hold & { client_user: { username: string; email: string | null; company_name: string } | null }

/**
 * Every hold of the booking this hold belongs to (lib/bookings.ts bookingKey:
 * all markets of a multi-market quote, a campaign group, or a Salesforce
 * opportunity), or the hold alone. A booking is one quote: extensions, cancel
 * and expiry edits act on all of it in one request.
 */
async function loadBooking(hold: HoldWithClient): Promise<HoldWithClient[]> {
  const key = bookingKey(hold)
  const ids = key ? (await loadBookingHolds(key)).map(h => h.id) : []
  if (!ids.includes(hold.id)) ids.push(hold.id)
  return prisma.hold.findMany({
    where:   { id: { in: ids } },
    include: { client_user: { select: { username: true, email: true, company_name: true } } },
  })
}

/** The start dates that cap the booking's one expiry (lib/bookings.ts bookingCapStarts). */
function capStarts(booking: Hold[]): string[] {
  const today = new Date().toISOString().slice(0, 10)
  return bookingCapStarts(booking.map(h => ({ start_date: h.start_date.toISOString().slice(0, 10), status: h.status })), today)
}

/** The end of a YYYY-MM-DD day, as a hand-set expiry is stored. */
const endOfDay = (d: string) => new Date(d + 'T23:59:59Z')
const day = (d: Date) => d.toISOString().slice(0, 10)

/** The booking's span and markets, for the client's email. */
function bookingSummary(holds: Hold[]) {
  return {
    markets:   [...new Set(holds.map(h => h.market))],
    trucks:    [...new Set(holds.map(h => h.truck_number))],
    startDate: holds.map(h => day(h.start_date)).sort()[0],
    endDate:   holds.map(h => day(h.end_date)).sort().reverse()[0],
  }
}

/**
 * PATCH /api/hold-requests/[id]
 *
 * Staff actions on a Hold record from the unified Reservations page.
 * Actions: swap_truck, cancel_notify, approve_extension, deny_extension,
 * update_expiration, reinstate.
 *
 * swap_truck acts on the named hold. reinstate, cancel_notify,
 * approve_extension, deny_extension and update_expiration act on its WHOLE
 * booking in one request (one transaction, one email): a booking is one quote.
 * Every expiry change or release (reinstate, approve or deny extension, update
 * expiration, cancel, truck swap) then syncs the opportunity's LED Trucks and Hold Exp to
 * Salesforce: the app owns them (lib/sfdcBooking.ts syncOpportunityLedWindow).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { action, truck_number, reason, expires_at: newExpiresAtStr, reopenOpportunity } = (await req.json().catch(() => ({}))) as {
    action?: Action; truck_number?: string; reason?: string; expires_at?: string
    /** Reinstate only: the person agreed to move a Closed Lost opportunity back to WARM. */
    reopenOpportunity?: boolean
  }
  if (!action || !(action in VALID_FROM)) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }

  const hold = await prisma.hold.findUnique({
    where:   { id: params.id },
    include: { client_user: { select: { username: true, email: true, company_name: true } } },
  })
  if (!hold) return NextResponse.json({ error: 'Hold not found' }, { status: 404 })

  const wonHold = closedWonRefusal([hold])
  if (wonHold && action !== 'swap_truck') {
    return NextResponse.json({ error: wonHold }, { status: 409 })
  }
  if (!VALID_FROM[action].includes(hold.status)) {
    return NextResponse.json(
      { error: `Cannot ${action.replace('_', ' ')} a hold with status ${hold.status}` },
      { status: 400 }
    )
  }

  // ── swap_truck ──────────────────────────────────────────────────────────
  // Allowed on a won deal: moving a truck is logistics; the deal is unchanged.
  if (action === 'swap_truck') {
    if (!truck_number) {
      return NextResponse.json({ error: 'truck_number is required' }, { status: 400 })
    }

    const oldTruck = hold.truck_number

    // Conflict check on new truck
    const conflicts = await prisma.hold.findMany({
      where: {
        truck_number,
        id:         { not: hold.id },
        ...activeHoldWhere(),
        start_date: { lte: hold.end_date },
        end_date:   { gte: hold.start_date },
      },
    })
    if (conflicts.length > 0) {
      const c = conflicts[0]
      return NextResponse.json({
        error: `Truck ${truck_number} already has a ${c.status} for "${c.client_name}" ` +
               `from ${c.start_date.toISOString().split('T')[0]} to ${c.end_date.toISOString().split('T')[0]}.`,
      }, { status: 409 })
    }

    await prisma.hold.update({
      where: { id: hold.id },
      data:  { truck_number },
    })

    await prisma.auditLog.create({
      data: {
        action:       'SWAP_HOLD_TRUCK',
        truck_number,
        user_id:      session.user.id,
        hold_id:      hold.id,
        details:      JSON.stringify({ old_truck: oldTruck, new_truck: truck_number }),
      },
    })
    // Metrics measure the new truck's way in (a fleet and GPS load): after the response.
    if (truck_number !== oldTruck) waitUntil(recordSwap(hold.id, session.user.id))

    // The old truck comes off Salesforce's LED Trucks, or its next push would
    // mirror it as a new reservation (lib/sfdcBooking.ts syncOpportunityLedWindow).
    const sfdcWarning = await syncOpportunityLedWindow(hold.sfdc_opportunity_id)
    return NextResponse.json({ ok: true, old_truck: oldTruck, new_truck: truck_number, sfdcWarning })
  }

  // ── reinstate ───────────────────────────────────────────────────────────
  // Puts an expired hold back in play with a fresh window. The expiry is recomputed rather than
  // restored: the old value is what lapsed, and for the short-lead holds this exists to rescue it
  // was already in the past at creation.
  //
  // While the hold's Opportunity is Closed Lost (closed by expireHolds() or by a rep) the
  // reconcile (every 15 minutes) would release it again, so the person is asked first whether to
  // move the deal back to WARM (409 `reopenable`); the request comes back with reopenOpportunity.
  // A Closed Won opportunity's hold comes back COMMITTED with no expiry: the deal is won, so the
  // truck is booked, not held (and nothing about the deal changes).
  // Staff only: this route takes staff sessions; the client portal reinstates nothing.
  if (action === 'reinstate') {
    // A quote-only log was never a reservation: it may have no truck
    // ("UNASSIGNED") and was priced without a feasibility check. Reinstating
    // it would silently turn it into a live hold. To reserve, re-quote.
    // A release record (lib/attSoftRelease.ts) is not a hold either: it only
    // stops the AT&T soft hold coming back. Undo it from the Conflicts page.
    const releaseRecord = reinstateBlockedByRelease(hold.origination)
    if (releaseRecord) return NextResponse.json({ error: releaseRecord }, { status: 400 })
    if (hold.origination === QUOTE_ONLY_ORIGINATION) {
      return NextResponse.json(
        { error: 'This is a quote-only log, not an expired reservation. To reserve trucks, get a fresh quote and place the hold.' },
        { status: 400 },
      )
    }
    const stage = hold.sfdc_opportunity_id ? await getOpportunityStage(hold.sfdc_opportunity_id) : null
    const decision = reactivationDecision(stage, reopenOpportunity === true)
    if (decision.kind === 'reopenable') {
      return NextResponse.json({
        error: `Can't reinstate: ${closedOpportunityBlocksReactivation(stage)}`,
        reopenable: { opportunityId: hold.sfdc_opportunity_id, stageName: decision.stageName, question: reopenQuestion(decision.stageName) },
      }, { status: 409 })
    }

    // The whole booking comes back, or none of it: every lapsed hold of it
    // whose market hasn't ended (lib/bookings.ts reinstatableHolds).
    const booking = await loadBooking(hold)
    const today = new Date().toISOString().slice(0, 10)
    const lapsed = reinstatableHolds(booking, today)
      .filter(h => h.origination !== QUOTE_ONLY_ORIGINATION && !reinstateBlockedByRelease(h.origination))
    if (lapsed.length === 0) return NextResponse.json({ error: NOTHING_TO_REINSTATE }, { status: 400 })
    const ids = lapsed.map(h => h.id)
    // Holds still marked live whose expiry has passed but the sweep hasn't
    // reached yet reserve nothing either: re-dating them below brings them
    // back, so they're clash-checked like the lapsed ones.
    const now = new Date()
    const live = booking.filter(h => h.status === 'HOLD' || h.status === 'EXTENSION_REQUESTED')
    const unswept = live.filter(h => !holdReservesNow(h, now) && day(h.end_date) >= today)
    const revived = [...lapsed, ...unswept]
    // While the booking sat expired its trucks read as free to every availability
    // path, so any of them may have been taken: check them all before blocking
    // any again (lib/bookings.ts reinstateRefusal).
    // One query for the whole booking, matched back to each lapsed hold.
    // Copies of this booking's own trucks that Salesforce's push mirrored onto
    // the same opportunity while it sat expired (the app had released it, so
    // the webhook recorded what Salesforce listed): the same deal, not a
    // clash. They're removed below as the app takes its trucks back.
    const mirrored = hold.sfdc_opportunity_id ? await prisma.hold.findMany({
      where:  { sfdc_opportunity_id: hold.sfdc_opportunity_id, source: 'SALESFORCE', truck_number: { in: revived.map(h => h.truck_number) } },
      select: { id: true, truck_number: true },
    }) : []
    const taken = await prisma.hold.findMany({
      where: {
        // Not this booking's own holds (or Salesforce's copies of them): only
        // someone else's booking is a clash.
        id:  { notIn: [...booking.map(h => h.id), ...mirrored.map(m => m.id)] },
        AND: [
          activeHoldWhere(),
          { OR: revived.map(h => ({ truck_number: h.truck_number, start_date: { lte: h.end_date }, end_date: { gte: h.start_date } })) },
        ],
      },
    })
    const clashes = revived.flatMap(h => {
      const c = taken.find(t => t.truck_number === h.truck_number && t.start_date <= h.end_date && t.end_date >= h.start_date)
      return c ? [{ truck: h.truck_number, client: c.client_name, start: day(c.start_date), end: day(c.end_date) }] : []
    })
    const refused = reinstateRefusal(clashes)
    if (refused) return NextResponse.json({ error: refused, clashes }, { status: 409 })

    const won = stage?.isClosed === true && stage.isWon
    // The booking's one expiry, on every hold of it: the reinstated ones and
    // any still live (an older booking whose markets lapsed apart). A later
    // expiry a live hold already has (an extension waiting, say) is kept, never
    // past the booking's cap.
    const keepUntil = live.map(h => h.expires_at).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null
    const newExpiresAt = won ? null : bookingHoldExpiry(capStarts(booking), DEFAULT_HOLD_DAYS, new Date(), keepUntil, STAFF_MIN_DAYS_BEFORE_START).expiresAt
    const newStatus = won ? 'COMMITTED' : 'HOLD'

    // The reinstate, the removal of Salesforce's copies of its trucks, and the
    // audit rows land together.
    const [reinstated] = await prisma.$transaction([
      prisma.hold.updateMany({
        where: { id: { in: ids }, status: 'EXPIRED' },
        data:  { status: newStatus, expires_at: newExpiresAt, extension_until: null, extension_reason: null },
      }),
      ...(!won && live.length ? [prisma.hold.updateMany({
        where: { id: { in: live.map(h => h.id) }, status: { in: ['HOLD', 'EXTENSION_REQUESTED'] } },
        data:  { expires_at: newExpiresAt },
      })] : []),
      ...(mirrored.length ? [
        prisma.hold.deleteMany({ where: { id: { in: mirrored.map(m => m.id) } } }),
        prisma.auditLog.createMany({
          data: mirrored.map(m => ({
            action:       'DELETE_HOLD',
            truck_number: m.truck_number,
            user_id:      session.user.id,
            hold_id:      m.id,
            details:      JSON.stringify({ reason: 'salesforce_copy_of_reinstated_app_truck', opportunityId: hold.sfdc_opportunity_id }),
          })),
        }),
      ] : []),
      prisma.auditLog.createMany({
        data: lapsed.map(h => ({
          action:       'REINSTATE_HOLD',
          truck_number: h.truck_number,
          user_id:      session.user.id,
          hold_id:      h.id,
          details:      JSON.stringify({
            lapsed_expires_at: h.expires_at,
            new_expires_at:    newExpiresAt?.toISOString() ?? null,
            status:            newStatus,
            booking:           bookingKey(h),
          }),
        })),
      }),
    ])

    // A Closed Lost deal the person agreed to reopen goes back to WARM only now,
    // with the reinstate saved: a push the stage change sets off finds the
    // app's holds live, so the webhook treats the opportunity as the app's
    // rather than mirroring its old trucks. If Salesforce refuses, the
    // reinstate is undone and nothing changes.
    let reopened: { fromStage: string; toStage: string } | null = null
    if (decision.kind === 'reopen') {
      const r = await reopenClosedLostOpportunity(hold.sfdc_opportunity_id!)
      if (!r.ok) {
        await prisma.$transaction([
          ...lapsed.map(h => prisma.hold.update({
            where: { id: h.id },
            data:  { status: 'EXPIRED', expires_at: h.expires_at, extension_until: h.extension_until, extension_reason: h.extension_reason },
          })),
          ...(!won ? live.map(h => prisma.hold.update({ where: { id: h.id }, data: { expires_at: h.expires_at } })) : []),
          prisma.auditLog.createMany({
            data: lapsed.map(h => ({
              action:       'REINSTATE_REVERTED',
              truck_number: h.truck_number,
              user_id:      session.user.id,
              hold_id:      h.id,
              details:      JSON.stringify({ reason: 'salesforce_refused_reopen', error: r.error, booking: bookingKey(h) }),
            })),
          }),
        ])
        return NextResponse.json({ error: `Can't reinstate: ${r.error}` }, { status: 409 })
      }
      reopened = r
      await prisma.auditLog.create({
        data: {
          action:       'REOPEN_OPPORTUNITY',
          truck_number: hold.truck_number,
          user_id:      session.user.id,
          hold_id:      hold.id,
          details:      JSON.stringify({
            opportunity_id: hold.sfdc_opportunity_id, from_stage: r.fromStage, to_stage: r.toStage,
            by: session.user.email ?? session.user.id, for: 'REINSTATE_HOLD',
          }),
        },
      }).catch(err => console.error('[reinstate] reopen audit failed:', err))
    }

    // Salesforce's LED Trucks and Hold Exp follow (lib/sfdcBooking.ts syncOpportunityLedWindow).
    const sfdcWarning = await syncOpportunityLedWindow(hold.sfdc_opportunity_id)

    // What actually came back: a hold reinstated by a request racing this one isn't counted twice.
    return NextResponse.json({ ok: true, status: newStatus, holds: reinstated.count, expires_at: newExpiresAt?.toISOString() ?? null, reopened, sfdcWarning })
  }

  // ── The whole booking: cancel, extensions, expiry ──────────────────────────
  const booking = await loadBooking(hold)
  // Its live, held reservations: what these actions change.
  const live = booking.filter(h => h.status === 'HOLD' || h.status === 'EXTENSION_REQUESTED')
  // A won deal is read-only: refuse when any of the booking is committed, or
  // Salesforce already says Closed Won (the reconcile commits it within 15 minutes).
  const stage = hold.sfdc_opportunity_id ? await getOpportunityStage(hold.sfdc_opportunity_id) : null
  const won = closedWonRefusal(booking, stage?.isClosed ? { isWon: stage.isWon } : null)
  if (won) return NextResponse.json({ error: won }, { status: 409 })

  // ── cancel_notify ───────────────────────────────────────────────────────
  if (action === 'cancel_notify') {
    await prisma.$transaction([
      prisma.auditLog.createMany({
        data: live.map(h => ({
          action:       'CANCEL_HOLD',
          truck_number: h.truck_number,
          user_id:      session.user.id,
          hold_id:      h.id,
          details:      JSON.stringify({ client_name: h.client_name, status: h.status, reason, booking: bookingKey(h) }),
        })),
      }),
      prisma.hold.deleteMany({ where: { id: { in: live.map(h => h.id) } } }),
    ])

    // One email to the client for the whole booking, when there is a reason and an address.
    let emailed = false
    const client = live.find(h => h.client_user?.email)?.client_user
    if (reason && client?.email) {
      const s = bookingSummary(live)
      try {
        await sendCancellationEmail({
          to:           client.email,
          companyName:  client.company_name,
          truckNumbers: s.trucks,
          markets:      s.markets,
          startDate:    s.startDate,
          endDate:      s.endDate,
          reason,
        })
        emailed = true
      } catch (err) {
        console.error('[cancel-notify] email send failed:', err)
      }
    }

    // The released trucks come off Salesforce's LED Trucks, or its next push would mirror them.
    const sfdcWarning = await syncOpportunityLedWindow(hold.sfdc_opportunity_id)
    return NextResponse.json({ ok: true, cancelled: live.length, emailed, sfdcWarning })
  }

  // ── approve_extension ───────────────────────────────────────────────────
  if (action === 'approve_extension') {
    // The booking's one expiry, on every live hold: the date the client asked
    // for, but never past the staff limit (2 days before its earliest start),
    // or the standard length when none was asked.
    const starts = capStarts(booking)
    const limit = endOfDay(lastExpiryDate([...starts].sort()[0], new Date(), STAFF_MIN_DAYS_BEFORE_START))
    const asked = live.map(h => h.extension_until).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0]
    const newExpiresAt = asked
      ? (asked > limit ? limit : asked)
      : bookingHoldExpiry(starts, DEFAULT_HOLD_DAYS, new Date(), null, STAFF_MIN_DAYS_BEFORE_START).expiresAt

    await prisma.$transaction([
      prisma.hold.updateMany({
        where: { id: { in: live.map(h => h.id) } },
        data:  { status: 'HOLD', expires_at: newExpiresAt, extension_until: null, extension_reason: null },
      }),
      prisma.auditLog.createMany({
        data: live.map(h => ({
          action:       'APPROVE_HOLD_EXTENSION',
          truck_number: h.truck_number,
          user_id:      session.user.id,
          hold_id:      h.id,
          details:      JSON.stringify({ new_expires_at: newExpiresAt.toISOString(), booking: bookingKey(h) }),
        })),
      }),
    ])

    const client = live.find(h => h.client_user?.email)?.client_user
    if (client?.email) {
      const s = bookingSummary(live)
      await sendExtensionDecisionEmail({
        to: client.email, companyName: client.company_name, markets: s.markets,
        startDate: s.startDate, endDate: s.endDate, heldUntil: day(newExpiresAt),
      }).catch(err => console.error('[approve-extension] email send failed:', err))
    }

    const sfdcWarning = await syncOpportunityLedWindow(hold.sfdc_opportunity_id)
    return NextResponse.json({ ok: true, status: 'HOLD', holds: live.length, expires_at: newExpiresAt.toISOString(), sfdcWarning })
  }

  // ── update_expiration ────────────────────────────────────────────────────
  if (action === 'update_expiration') {
    if (!newExpiresAtStr) {
      return NextResponse.json({ error: 'expires_at is required' }, { status: 400 })
    }
    const newExp = /^\d{4}-\d{2}-\d{2}$/.test(newExpiresAtStr) ? endOfDay(newExpiresAtStr) : new Date(NaN)
    if (isNaN(newExp.getTime())) {
      return NextResponse.json({ error: 'Invalid date' }, { status: 400 })
    }
    // Refused, not quietly cut back: the booking's one expiry can't run past
    // 2 days before its earliest start (the Edit dialog blocks the same date).
    const earliest = [...capStarts(booking)].sort()[0]
    const lastDate = lastExpiryDate(earliest, new Date(), STAFF_MIN_DAYS_BEFORE_START)
    if (newExpiresAtStr > lastDate) {
      return NextResponse.json({
        error: `The latest this booking can be held is ${lastDate}: ${STAFF_MIN_DAYS_BEFORE_START} days before its first market starts (${earliest}).`,
        lastDate,
      }, { status: 400 })
    }
    const closed = closedOpportunityBlocksReactivation(stage)
    if (closed) return NextResponse.json({ error: `Can't change the expiry: ${closed}` }, { status: 409 })

    // Every live hold of the booking to the one date.
    await prisma.$transaction([
      prisma.hold.updateMany({
        where: { id: { in: live.map(h => h.id) } },
        data:  { expires_at: newExp, status: 'HOLD', extension_until: null, extension_reason: null },
      }),
      prisma.auditLog.createMany({
        data: live.map(h => ({
          action:       'UPDATE_HOLD_EXPIRATION',
          truck_number: h.truck_number,
          user_id:      session.user.id,
          hold_id:      h.id,
          details:      JSON.stringify({ new_expires_at: newExp.toISOString(), booking: bookingKey(h) }),
        })),
      }),
    ])

    const sfdcWarning = await syncOpportunityLedWindow(hold.sfdc_opportunity_id)
    return NextResponse.json({ ok: true, holds: live.length, expires_at: newExp.toISOString(), sfdcWarning })
  }

  // ── deny_extension ──────────────────────────────────────────────────────
  // Denying releases the whole booking.
  await prisma.$transaction([
    prisma.hold.updateMany({ where: { id: { in: live.map(h => h.id) } }, data: { status: 'EXPIRED' } }),
    prisma.auditLog.createMany({
      data: live.map(h => ({
        action:       'DENY_HOLD_EXTENSION',
        truck_number: h.truck_number,
        user_id:      session.user.id,
        hold_id:      h.id,
        details:      JSON.stringify({ booking: bookingKey(h) }),
      })),
    }),
  ])

  // Denying the extension expires the booking, so settle Salesforce the same way the
  // sweep does (expiryClosesOpportunity), once. Only closes if no active hold is left
  // on the Opportunity, and never allowed to fail the request; the helper swallows its
  // own errors.
  // The released trucks come off Salesforce's LED Trucks first, or its next push would mirror them.
  const sfdcWarning = await syncOpportunityLedWindow(hold.sfdc_opportunity_id)
  if (hold.sfdc_opportunity_id && expiryClosesOpportunity(hold)) {
    await closeOpportunityAsLost(hold.sfdc_opportunity_id)
  }

  const client = live.find(h => h.client_user?.email)?.client_user
  if (client?.email) {
    const s = bookingSummary(live)
    await sendExtensionDecisionEmail({
      to: client.email, companyName: client.company_name, markets: s.markets, startDate: s.startDate, endDate: s.endDate,
    }).catch(err => console.error('[deny-extension] email send failed:', err))
  }

  return NextResponse.json({ ok: true, status: 'EXPIRED', holds: live.length, sfdcWarning })
}

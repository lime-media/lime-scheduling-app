import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere, holdReservesNow } from '@/lib/holdFilters'
import { CLOSED_WON_READ_ONLY, closedWonRefusal } from '@/lib/bookings'
import { getOpportunityStage } from '@/lib/sfdcOpportunityReconcile'
import { recordSwap, recordWon, winsToRecord } from '@/lib/transportMetricsRecord'
import { waitUntil } from '@vercel/functions'
import { HoldClashError, HoldLockTimeoutError, writeHoldsExclusive } from '@/lib/holdWriteLock'
import { syncOpportunityLedWindow } from '@/lib/sfdcBooking'
import { clearBookingCancel } from '@/lib/cancelBooking'
import { withAskedDates } from '@/lib/quoteFeatures'
import { daysBetween } from '@/lib/planning/planner'

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const hold = await prisma.hold.findUnique({ where: { id: params.id } })
  if (!hold) {
    return NextResponse.json({ error: 'Hold not found' }, { status: 404 })
  }

  // Sales can only edit their own holds
  if (session.user.role === 'SALES' && hold.created_by !== session.user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { status, notes, start_date, end_date, client_name, market, state, truck_number } = body

  // A date that isn't one is refused, not a 500 from toISOString, and before
  // Salesforce or the swap check are asked (REVIEW.md "Cheap checks before expensive calls").
  // Strict: Date.parse takes 2026-02-30 as March 2 and other formats in server
  // time. A date, or the same date as UTC midnight (how a Date serialises).
  const isDate = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}(T00:00:00(\.000)?Z)?$/.test(d)
    && new Date(d.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) === d.slice(0, 10)
  if ([start_date, end_date].some(d => d !== undefined && d !== null && d !== '' && !isDate(d))) {
    return NextResponse.json({ error: 'start_date and end_date must be dates (YYYY-MM-DD).' }, { status: 400 })
  }
  const effStart = (start_date ? new Date(start_date) : hold.start_date).toISOString().slice(0, 10)
  const effEnd = (end_date ? new Date(end_date) : hold.end_date).toISOString().slice(0, 10)
  if (effStart > effEnd) return NextResponse.json({ error: 'The start date must be on or before the end date.' }, { status: 400 })

  // Only Salesforce commits a hold. Committed means Closed Won (lib/bookings.ts
  // closedWonRefusal), and the reconcile un-commits it if the deal leaves Closed
  // Won; a hold committed here on an open deal, or with no deal, would be locked
  // with nothing in Salesforce to change (#120 review). So committing checks the
  // live stage, and an unknown stage refuses rather than guesses.
  let wonStage: Awaited<ReturnType<typeof getOpportunityStage>> = null
  if (status === 'COMMITTED' && hold.status !== 'COMMITTED') {
    const stage = hold.sfdc_opportunity_id ? await getOpportunityStage(hold.sfdc_opportunity_id) : null
    wonStage = stage
    if (!stage?.isClosed || !stage.isWon) {
      return NextResponse.json({
        error: hold.sfdc_opportunity_id
          ? 'A reservation is committed when its opportunity is Closed Won in Salesforce. Mark it Closed Won there; the app commits it within 15 minutes.'
          : 'A reservation is committed when its Salesforce opportunity is Closed Won, and this one has no opportunity.',
      }, { status: 409 })
    }
  }

  // A committed hold is a Closed Won deal: read-only here except a truck swap
  // (logistics; the deal is unchanged) and a note (lib/bookings.ts closedWonRefusal).
  if (closedWonRefusal([hold])) {
    const changes = Object.keys(body).filter(k => body[k] !== undefined && !(k === 'status' && body[k] === 'COMMITTED'))
    if (changes.some(k => k !== 'truck_number' && k !== 'notes')) {
      return NextResponse.json({ error: CLOSED_WON_READ_ONLY }, { status: 409 })
    }
  }

  // If swapping trucks, check for conflicts on the new truck
  if (truck_number && truck_number !== hold.truck_number) {
    const effectiveStart = start_date ? new Date(start_date) : hold.start_date
    const effectiveEnd = end_date ? new Date(end_date) : hold.end_date
    const conflicts = await prisma.hold.findMany({
      where: {
        truck_number,
        id: { not: hold.id },
        ...activeHoldWhere(),
        start_date: { lte: effectiveEnd },
        end_date: { gte: effectiveStart },
      },
    })
    if (conflicts.length > 0) {
      const c = conflicts[0]
      return NextResponse.json({
        error: `Truck ${truck_number} already has a ${c.status} for "${c.client_name}" ` +
               `from ${c.start_date.toISOString().split('T')[0]} to ${c.end_date.toISOString().split('T')[0]}.`,
      }, { status: 409 })
    }
  }

  const day = (d: Date) => d.toISOString().slice(0, 10)
  const startMoved = effStart !== day(hold.start_date)
  const endMoved = effEnd !== day(hold.end_date)
  const data = {
    ...(status && { status }),
    // Made live again: no longer cancelled (lib/cancelBooking.ts), or a later lapse would read as one.
    ...(status && status !== 'EXPIRED' && { cancelled_at: null, cancel_reason: null, cancelled_by: null }),
    // Committed is booked, not held: no expiry left to show or sweep.
    ...(status === 'COMMITTED' && { expires_at: null, extension_until: null, extension_reason: null }),
    ...(notes !== undefined && { notes }),
    ...(start_date && { start_date: new Date(start_date) }),
    ...(end_date && { end_date: new Date(end_date) }),
    ...(client_name && { client_name }),
    ...(market && { market }),
    ...(state && { state }),
    ...(truck_number && { truck_number }),
  }
  // A change that puts a truck on dates (another truck, other dates, or an
  // expired hold made live again) is written under the truck's lock and
  // re-checked for any other live hold on those dates (lib/holdWriteLock.ts).
  // Before, only a truck swap was checked, and only before the write.
  const effTruck = truck_number || hold.truck_number
  // Made live again: an EXPIRED hold given a live status, or one whose expiry
  // passed (unswept) committed, which clears the expiry (holdFilters.ts).
  const reservesAfter = holdReservesNow({ status: status ?? hold.status, expires_at: status === 'COMMITTED' ? null : hold.expires_at })
  const revived = reservesAfter && !holdReservesNow(hold)
  const reserves = (status ?? hold.status) !== 'EXPIRED'
  const movesTruck = effTruck !== hold.truck_number || startMoved || endMoved || revived
  // Re-dated: the asked-for dates move with the hold's, so revising reopens
  // on the new dates, not the quote's (lib/quoteFeatures.ts withAskedDates).
  // Features are read under an update lock inside the write, so a features
  // write that starts meanwhile waits for this one rather than being
  // overwritten. A writer that read earlier (lib/sfdcBooking.ts setFeatures)
  // can still overwrite it; that is setFeatures' own read-then-write.
  // The move is measured from the locked row's dates, not the ones read
  // before the lock, so two re-dates in a row don't both shift from the same
  // starting point and double-move the asked-for dates.
  const write = async (tx: Prisma.TransactionClient) => {
    if (!startMoved && !endMoved) return tx.hold.update({ where: { id: params.id }, data })
    const [row] = await tx.$queryRaw<{ features: string | null; start_date: Date; end_date: Date }[]>`SELECT features, start_date, end_date FROM dbo.app_holds WITH (UPDLOCK, ROWLOCK) WHERE id = ${params.id}`
    const current = row?.features ?? null
    const from = row ?? hold
    // A side this request doesn't send keeps the locked row's date (another
    // edit may have moved it since the read above): it hasn't moved here.
    const newStart = start_date ? effStart : day(from.start_date)
    const newEnd = end_date ? effEnd : day(from.end_date)
    const features = withAskedDates(current, { startDays: daysBetween(day(from.start_date), newStart), endDays: daysBetween(day(from.end_date), newEnd) }, { start: newStart, end: newEnd })
    return tx.hold.update({ where: { id: params.id }, data: features === current ? data : { ...data, features } })
  }
  let updated: Awaited<ReturnType<typeof prisma.hold.update>>
  try {
    updated = reserves && movesTruck
      ? await writeHoldsExclusive([{ truck: effTruck, start: effStart, end: effEnd }], write,
        // A live hold whose dates move on the same truck: an AT&T soft hold under
        // it gives way, as it did when the hold was placed. Another truck, or a
        // lapsed hold brought back (a new reservation): soft holds count, as the
        // swap check and reinstate always have.
        { ignoreHoldIds: [hold.id], excludeAttSoft: effTruck === hold.truck_number && !revived })
      // Only a re-date reads and rewrites features: anything else is one update.
      : startMoved || endMoved ? await prisma.$transaction(write) : await prisma.hold.update({ where: { id: params.id }, data })
  } catch (err) {
    if (err instanceof HoldClashError) return NextResponse.json({ error: err.message, clashes: err.clashes }, { status: 409 })
    if (err instanceof HoldLockTimeoutError) return NextResponse.json({ error: err.message }, { status: 409 })
    throw err
  }

  // A lapsed or cancelled hold brought back: its booking is no longer cancelled
  // anywhere, even when this row lapsed on its own and only the others carry the mark.
  if (hold.status === 'EXPIRED' && updated.status !== 'EXPIRED') await clearBookingCancel(updated)

  await prisma.auditLog.create({
    data: {
      action: 'UPDATE_HOLD',
      truck_number: hold.truck_number,
      user_id: session.user.id,
      hold_id: hold.id,
      details: JSON.stringify(body),
    },
  })
  // Committed here: record the won Amount now, once per opportunity (the same
  // check the reconcile makes, so a deal reopened and won again, or committed
  // here and seen by the reconcile, isn't recorded twice).
  if (wonStage && hold.sfdc_opportunity_id) {
    const opportunityId = hold.sfdc_opportunity_id
    const amount = wonStage.amount, stageName = wonStage.stageName, clientName = hold.client_name
    waitUntil((async () => {
      if ((await winsToRecord([opportunityId.slice(0, 15)])).length) await recordWon({ opportunityId, amount, stageName, clientName })
    })())
  }
  // A truck swapped onto the hold: a SWAPPED transport leg (best-effort, after the response).
  if (truck_number && truck_number !== hold.truck_number) waitUntil(recordSwap(hold.id, session.user.id))

  // A truck, date or status change moves what the opportunity reserves:
  // Salesforce's LED Trucks and Hold Exp follow (lib/sfdcBooking.ts syncOpportunityLedWindow).
  const moved = updated.truck_number !== hold.truck_number
    || updated.status !== hold.status
    || updated.start_date.getTime() !== hold.start_date.getTime()
    || updated.end_date.getTime() !== hold.end_date.getTime()
  const sfdcWarning = moved ? await syncOpportunityLedWindow(hold.sfdc_opportunity_id) : null

  return NextResponse.json({ ...updated, sfdcWarning })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const hold = await prisma.hold.findUnique({ where: { id: params.id } })
  if (!hold) {
    return NextResponse.json({ error: 'Hold not found' }, { status: 404 })
  }

  // Sales can only delete their own holds
  if (session.user.role === 'SALES' && hold.created_by !== session.user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // A won deal is never deleted here (lib/bookings.ts closedWonRefusal).
  if (closedWonRefusal([hold])) {
    return NextResponse.json({ error: CLOSED_WON_READ_ONLY }, { status: 409 })
  }

  await prisma.auditLog.create({
    data: {
      action: 'DELETE_HOLD',
      truck_number: hold.truck_number,
      user_id: session.user.id,
      hold_id: hold.id,
      details: JSON.stringify({ client_name: hold.client_name, status: hold.status }),
    },
  })

  await prisma.hold.delete({ where: { id: params.id } })

  // The truck is released: Salesforce's LED Trucks (and Hold Exp) follow, so
  // its next push can't re-create the deleted hold (lib/sfdcBooking.ts syncOpportunityLedWindow).
  const sfdcWarning = await syncOpportunityLedWindow(hold.sfdc_opportunity_id)

  return NextResponse.json({ success: true, sfdcWarning })
}

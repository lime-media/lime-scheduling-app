import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { computeHoldExpiresAt } from '@/lib/holdRequestService'
import { sendCancellationEmail } from '@/lib/email'

type Action = 'swap_truck' | 'cancel_notify' | 'approve_extension' | 'deny_extension' | 'update_expiration'

const VALID_FROM: Record<Action, string[]> = {
  swap_truck:         ['HOLD', 'COMMITTED'],
  cancel_notify:      ['HOLD', 'COMMITTED', 'EXTENSION_REQUESTED'],
  approve_extension:  ['EXTENSION_REQUESTED'],
  deny_extension:     ['EXTENSION_REQUESTED'],
  update_expiration:  ['HOLD', 'COMMITTED', 'EXTENSION_REQUESTED'],
}

/**
 * PATCH /api/hold-requests/[id]
 *
 * Staff actions on a Hold record from the unified Reservations page.
 * Actions: swap_truck, cancel_notify, approve_extension, deny_extension.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { action, truck_number, reason, expires_at: newExpiresAtStr } = (await req.json().catch(() => ({}))) as {
    action?: Action; truck_number?: string; reason?: string; expires_at?: string
  }
  if (!action || !(action in VALID_FROM)) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }

  const hold = await prisma.hold.findUnique({
    where:   { id: params.id },
    include: { client_user: { select: { username: true, email: true, company_name: true } } },
  })
  if (!hold) return NextResponse.json({ error: 'Hold not found' }, { status: 404 })

  if (!VALID_FROM[action].includes(hold.status)) {
    return NextResponse.json(
      { error: `Cannot ${action.replace('_', ' ')} a hold with status ${hold.status}` },
      { status: 400 }
    )
  }

  // ── swap_truck ──────────────────────────────────────────────────────────
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
        status:     { not: 'EXPIRED' },
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

    return NextResponse.json({ ok: true, old_truck: oldTruck, new_truck: truck_number })
  }

  // ── cancel_notify ───────────────────────────────────────────────────────
  if (action === 'cancel_notify') {
    await prisma.auditLog.create({
      data: {
        action:       'CANCEL_HOLD',
        truck_number: hold.truck_number,
        user_id:      session.user.id,
        hold_id:      hold.id,
        details:      JSON.stringify({
          client_name: hold.client_name,
          status: hold.status,
          reason,
        }),
      },
    })

    await prisma.hold.delete({ where: { id: hold.id } })

    // Email the client if we have their email
    let emailed = false
    const clientEmail = hold.client_user?.email
    if (reason && clientEmail) {
      const startDate = hold.start_date.toISOString().split('T')[0]
      const endDate = hold.end_date.toISOString().split('T')[0]
      try {
      await sendCancellationEmail({
        to:          clientEmail,
        companyName: hold.client_user!.company_name,
        truckNumber: hold.truck_number,
        market:      hold.market,
        startDate,
        endDate,
        reason,
      })
      emailed = true
      } catch (err) {
        console.error('[cancel-notify] email send failed:', err)
      }
    }

    return NextResponse.json({ ok: true, emailed })
  }

  // ── approve_extension ───────────────────────────────────────────────────
  if (action === 'approve_extension') {
    const newExpiresAt = hold.extension_until
      ? hold.extension_until
      : computeHoldExpiresAt(hold.start_date.toISOString().split('T')[0])

    await prisma.hold.update({
      where: { id: hold.id },
      data:  { status: 'HOLD', expires_at: newExpiresAt, extension_until: null, extension_reason: null },
    })

    await prisma.auditLog.create({
      data: {
        action:       'APPROVE_HOLD_EXTENSION',
        truck_number: hold.truck_number,
        user_id:      session.user.id,
        hold_id:      hold.id,
        details:      JSON.stringify({ new_expires_at: newExpiresAt.toISOString() }),
      },
    })

    return NextResponse.json({ ok: true, status: 'HOLD', expires_at: newExpiresAt.toISOString() })
  }

  // ── update_expiration ────────────────────────────────────────────────────
  if (action === 'update_expiration') {
    if (!newExpiresAtStr) {
      return NextResponse.json({ error: 'expires_at is required' }, { status: 400 })
    }
    const newExp = new Date(newExpiresAtStr + 'T23:59:59Z')
    if (isNaN(newExp.getTime())) {
      return NextResponse.json({ error: 'Invalid date' }, { status: 400 })
    }

    await prisma.hold.update({
      where: { id: hold.id },
      data: {
        expires_at: newExp,
        status: 'HOLD',
        extension_until: null,
        extension_reason: null,
      },
    })

    await prisma.auditLog.create({
      data: {
        action:       'UPDATE_HOLD_EXPIRATION',
        truck_number: hold.truck_number,
        user_id:      session.user.id,
        hold_id:      hold.id,
        details:      JSON.stringify({ new_expires_at: newExp.toISOString() }),
      },
    })

    return NextResponse.json({ ok: true, expires_at: newExp.toISOString() })
  }

  // ── deny_extension ──────────────────────────────────────────────────────
  await prisma.hold.update({ where: { id: hold.id }, data: { status: 'EXPIRED' } })

  await prisma.auditLog.create({
    data: {
      action:       'DENY_HOLD_EXTENSION',
      truck_number: hold.truck_number,
      user_id:      session.user.id,
      hold_id:      hold.id,
      details:      JSON.stringify({}),
    },
  })

  return NextResponse.json({ ok: true, status: 'EXPIRED' })
}

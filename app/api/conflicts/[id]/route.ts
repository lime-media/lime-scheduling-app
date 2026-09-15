import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getPool } from '@/lib/mssql'
import { prisma } from '@/lib/prisma'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { action } = await req.json()
  const pool = await getPool()

  // ── Fetch the conflict record ──────────────────────────────────────────────
  const lookup = await pool
    .request()
    .input('id', params.id)
    .query(`
      SELECT
        id, hold_id, truck_number, scheduled_program,
        CONVERT(varchar(10), conflict_start, 120) AS conflict_start,
        CONVERT(varchar(10), conflict_end,   120) AS conflict_end
      FROM dbo.schedule_conflicts
      WHERE id = @id
    `)

  if (lookup.recordset.length === 0) {
    return NextResponse.json({ error: 'Conflict not found' }, { status: 404 })
  }

  const conflict = lookup.recordset[0] as {
    id: string; hold_id: string; truck_number: string; scheduled_program: string
    conflict_start: string; conflict_end: string
  }

  // ── Resolve: mark conflict RESOLVED, keep hold intact ─────────────────────
  if (action === 'resolve') {
    await pool
      .request()
      .input('id',     params.id)
      .input('userId', session.user.id)
      .query(`
        UPDATE dbo.schedule_conflicts
        SET status = 'RESOLVED', resolved_at = GETUTCDATE(), resolved_by = @userId
        WHERE id = @id
      `)
    return NextResponse.json({ success: true })
  }

  // ── Release hold: delete hold (cascade removes conflict), audit it ─────────
  if (action === 'release-hold') {
    const hold = await prisma.hold.findUnique({ where: { id: conflict.hold_id } })
    if (!hold) {
      // Hold already gone — just resolve the conflict record
      await pool
        .request()
        .input('id',     params.id)
        .input('userId', session.user.id)
        .query(`
          UPDATE dbo.schedule_conflicts
          SET status = 'RESOLVED', resolved_at = GETUTCDATE(), resolved_by = @userId
          WHERE id = @id
        `)
      return NextResponse.json({ success: true })
    }

    // The conflict row is a snapshot taken when it was detected, and nothing about editing a
    // reservation updates it. If the hold has since moved to another truck or off these dates,
    // this row describes a conflict that no longer exists — and deleting the hold would destroy
    // a reservation that is now perfectly fine. Resolve is the right action on a stale row.
    const holdStart = hold.start_date.toISOString().split('T')[0]
    const holdEnd   = hold.end_date.toISOString().split('T')[0]
    const stale =
      hold.truck_number !== conflict.truck_number ||
      holdStart > conflict.conflict_end ||
      holdEnd   < conflict.conflict_start

    if (stale) {
      return NextResponse.json({
        error:
          `This conflict is out of date — it was raised against truck ${conflict.truck_number} ` +
          `for ${conflict.conflict_start}–${conflict.conflict_end}, but the reservation now uses ` +
          `truck ${hold.truck_number} for ${holdStart}–${holdEnd}. Resolve it instead; releasing ` +
          `would delete a reservation that is no longer in conflict.`,
        stale: true,
      }, { status: 409 })
    }

    // Audit log before deletion
    await prisma.auditLog.create({
      data: {
        action:       'DELETE_HOLD',
        truck_number: hold.truck_number,
        user_id:      session.user.id,
        hold_id:      hold.id,
        details:      JSON.stringify({
          reason:      'conflict_resolution',
          conflict_id: params.id,
          program:     conflict.scheduled_program,
        }),
      },
    })

    // Delete hold — ON DELETE CASCADE removes the conflict row automatically
    await prisma.hold.delete({ where: { id: conflict.hold_id } })
    return NextResponse.json({ success: true })
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}

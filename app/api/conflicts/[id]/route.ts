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
      SELECT id, hold_id, truck_number, scheduled_program
      FROM dbo.schedule_conflicts
      WHERE id = @id
    `)

  if (lookup.recordset.length === 0) {
    return NextResponse.json({ error: 'Conflict not found' }, { status: 404 })
  }

  const conflict = lookup.recordset[0] as {
    id: string; hold_id: string; truck_number: string; scheduled_program: string
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

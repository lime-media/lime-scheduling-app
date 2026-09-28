/**
 * GET /api/holds/att-soft/releases — AT&T soft-hold releases still in effect
 * (ending today or later): who released which truck's dates, and for what.
 * The Conflicts page lists them with Undo (DELETE /api/holds/att-soft/release).
 */

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { ATT_RELEASE_ORIGINATION } from '@/lib/attSoftRules'

const iso = (d: Date) => d.toISOString().slice(0, 10)

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const today = new Date(); today.setUTCHours(0, 0, 0, 0)
  const rows = await prisma.hold.findMany({
    where: { origination: ATT_RELEASE_ORIGINATION, status: 'EXPIRED', end_date: { gte: today } },
    include: { user: { select: { name: true } } },
    orderBy: { start_date: 'asc' },
  })
  return NextResponse.json({
    releases: rows.map(r => ({
      id: r.id, truckNumber: r.truck_number, start: iso(r.start_date), end: iso(r.end_date),
      by: r.user?.name ?? null, at: r.created_at.toISOString(), notes: r.notes ?? '',
    })),
  })
}

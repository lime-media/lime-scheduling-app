import { NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { prisma } from '@/lib/prisma'
import { activeHoldWhere } from '@/lib/holdFilters'

/**
 * GET /api/v1/internal/publishable-work
 *
 * Reservations that drivers may be offered, for the driver portal.
 *
 * This endpoint exists so that "which work is publishable" is decided HERE,
 * once, next to the holds — rather than in a sync script that re-derives it and
 * drifts. The driver portal ingests what it is given and never second-guesses
 * it. It also means this app can change its schema without breaking drivers.
 *
 * Returns the FULL current set, not a delta. The consumer closes anything it
 * stops seeing, which makes a missed run self-healing rather than permanently
 * wrong.
 *
 * What counts as publishable
 * --------------------------
 *   - Active: not EXPIRED, and not past expires_at. activeHoldWhere() derives
 *     that rather than trusting status alone, because the expiry sweep can lag.
 *   - Not ATT_SOFT: those are auto-generated placeholders with no market, held
 *     against a program that may never happen. Nobody should be offered one.
 *   - Starting in the future: a campaign already under way is not work to staff.
 *
 * Client-sourced holds ARE included. They are real campaigns that need drivers
 * as much as internally-booked ones. If client-booked work should be staffed
 * differently, this is the line to change.
 */
export async function GET(request: Request) {
  const authError = validateInternalApiKey(request)
  if (authError) return authError

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  try {
    const holds = await prisma.hold.findMany({
      where: {
        ...activeHoldWhere({ excludeAttSoft: true }),
        start_date: { gte: today },
      },
      orderBy: { start_date: 'asc' },
      select: {
        id: true,
        truck_number: true,
        market: true,
        state: true,
        start_date: true,
        end_date: true,
        expires_at: true,
        updated_at: true,
      },
    })

    return NextResponse.json({
      jobs: holds.map(h => ({
        hold_id:      h.id,
        truck_number: h.truck_number,
        market:       h.market,
        state:        h.state || null,
        start_date:   h.start_date.toISOString().split('T')[0],
        end_date:     h.end_date.toISOString().split('T')[0],
        // When this work stops being real. Null means it does not lapse on its
        // own — the portal tells drivers plainly rather than letting a job vanish.
        expires_at:   h.expires_at ? h.expires_at.toISOString() : null,
        updated_at:   h.updated_at ? h.updated_at.toISOString() : null,
      })),
      // Deliberately NOT included: client_name. The driver portal has open
      // signup, so anyone with the link sees this list. A driver needs to know
      // where and when, not for whom, until they are actually assigned.
      generated_at: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[v1/internal/publishable-work] Error:', error)
    return NextResponse.json({ error: 'Failed to fetch publishable work' }, { status: 500 })
  }
}

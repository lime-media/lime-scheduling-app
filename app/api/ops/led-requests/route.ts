/**
 * GET /api/ops/led-requests
 *
 * The live bookings that won't convert cleanly into an LED program, and why
 * (lib/campaignRequests.ts): blocking issues stop the convert; warnings
 * convert with something assumed that ops should check in LED. Bookings
 * whose dates have all passed, and quote-only logs, are left out. Any
 * signed-in staff user.
 */

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { centralDate } from '@/lib/dateOnly'
import { QUOTE_ONLY_ORIGINATION } from '@/lib/quoteOnly'
import { buildRequests, type RequestHold } from '@/lib/campaignRequests'

export const dynamic = 'force-dynamic'

const day = (d: Date) => d.toISOString().slice(0, 10)

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const today = centralDate(new Date())
    const [holds, links] = await Promise.all([
      prisma.hold.findMany({
        where: { status: { in: ['HOLD', 'EXTENSION_REQUESTED', 'COMMITTED'] }, origination: { not: QUOTE_ONLY_ORIGINATION }, end_date: { gte: new Date(today) } },
        select: {
          id: true, truck_number: true, market: true, state: true, client_name: true, start_date: true, end_date: true, status: true,
          campaign_group_id: true, sfdc_opportunity_id: true, sfdc_account_id: true, sfdc_job_number: true, standard_market_uid: true,
          quoted_total: true, features: true,
        },
      }),
      prisma.ledClientLink.findMany({ select: { sfdc_account_id: true, client_uid: true } }),
    ])
    const clientOf = new Map(links.map(l => [l.sfdc_account_id, l.client_uid]))
    const rows: RequestHold[] = holds.map(h => ({ ...h, start_date: day(h.start_date), end_date: day(h.end_date) }))
    const all = buildRequests(rows, a => clientOf.get(a) ?? null)
    const bookings = all
      .filter(b => b.issues.length > 0)
      .map(b => ({
        key: b.request.externalRef,
        client: b.request.campaignName,
        won: b.won,
        start: b.request.startDate,
        end: b.request.endDate,
        markets: b.request.markets.map((m, i) => ({ name: b.marketNames[i], trucks: m.trucks })),
        issues: b.issues,
      }))
      .sort((a, b) => Number(b.issues.some(i => i.blocking)) - Number(a.issues.some(i => i.blocking)) || a.start.localeCompare(b.start))
    return NextResponse.json({ total: all.length, blocked: bookings.filter(b => b.issues.some(i => i.blocking)).length, bookings })
  } catch (err) {
    console.error('[led-requests] read failed:', err)
    return NextResponse.json({ error: "Bookings couldn't be read. Try again shortly." }, { status: 502 })
  }
}

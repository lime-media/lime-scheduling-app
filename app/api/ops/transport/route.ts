/**
 * GET /api/ops/transport?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Transport and deal-value KPIs (lib/transportMetrics.ts) for bookings made in
 * the range (default: the last 30 days), from app_transport_legs and
 * app_deal_values: quoted transport (local / absorbed / billed, $ charged vs
 * our estimated cost, by client and market), planned vs actual, churn, and the
 * app's quote vs Salesforce's Amount at Closed Won. Any signed-in staff user.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { churnKpis, dealDrift, plannedVsActual, transportKpis, type DealRow, type LegRow } from '@/lib/transportMetrics'

const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v)
const MAX_ROWS = 20000
// SQL Server takes at most 2100 parameters per query, and Prisma won't split an
// `in` list for a query with `take`: look ids up in slices.
const IN_CHUNK = 2000
async function inChunks<T>(ids: string[], query: (slice: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length && out.length < MAX_ROWS; i += IN_CHUNK) out.push(...await query(ids.slice(i, i + IN_CHUNK)))
  return out.slice(0, MAX_ROWS)
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const to = isDate(sp.get('to')) ? sp.get('to')! : new Date().toISOString().slice(0, 10)
  const from = isDate(sp.get('from')) ? sp.get('from')! : new Date(Date.parse(to) - 30 * 86_400_000).toISOString().slice(0, 10)
  // Through the end of `to` (before the next day begins, fractions of a second included).
  const range = { gte: new Date(from + 'T00:00:00Z'), lt: new Date(Date.parse(to + 'T00:00:00Z') + 86_400_000) }

  try {
    // Bookings made in the range, and every later leg of them. By booking, not
    // hold: a revision replaces the holds (new ids) and keeps the booking key.
    const booked = await prisma.transportLeg.findMany({ where: { event: 'BOOKED', created_at: range }, select: { booking_key: true }, take: MAX_ROWS })
    const keys = [...new Set(booked.map(b => b.booking_key).filter((k): k is string => !!k))]
    const legs = await inChunks(keys, slice => prisma.transportLeg.findMany({ where: { booking_key: { in: slice } }, take: MAX_ROWS }))
    const legRows: LegRow[] = legs.map(l => ({ ...l, charge: Number(l.charge), est_cost: Number(l.est_cost) }))
    // Quoted transport is everything quoted, cancelled bookings included
    // (quotedPlan keeps one leg per truck slot, so a revision's replaced holds
    // don't count twice). Planned vs actual is on holds that still exist: a
    // revision deletes the holds it replaces, and a cancelled booking never ran.
    const legHoldIds = [...new Set(legRows.map(l => l.hold_id).filter((id): id is string => !!id))]
    const live = new Set((await inChunks(legHoldIds, slice => prisma.hold.findMany({ where: { id: { in: slice } }, select: { id: true } }))).map(h => h.id))
    const current = legRows.filter(l => l.hold_id && live.has(l.hold_id))

    // Opportunities booked in the range, and every value captured for them.
    const dealsBooked = await prisma.dealValue.findMany({
      where: { event: { in: ['BOOKED', 'REVISED'] }, captured_at: range, sfdc_opportunity_id: { not: null } },
      select: { sfdc_opportunity_id: true }, take: MAX_ROWS,
    })
    const oppIds = [...new Set(dealsBooked.map(d => d.sfdc_opportunity_id!))]
    const deals = await inChunks(oppIds, slice => prisma.dealValue.findMany({ where: { sfdc_opportunity_id: { in: slice } }, take: MAX_ROWS }))
    const dealRows: DealRow[] = deals.map(d => ({
      ...d,
      app_quoted_total: d.app_quoted_total == null ? null : Number(d.app_quoted_total),
      sf_amount: d.sf_amount == null ? null : Number(d.sf_amount),
    }))

    return NextResponse.json({
      from, to,
      transport: transportKpis(legRows),
      plannedVsActual: plannedVsActual(current),
      churn: churnKpis(legRows),
      deals: dealDrift(dealRows),
      truncated: booked.length >= MAX_ROWS || legs.length >= MAX_ROWS || dealsBooked.length >= MAX_ROWS || deals.length >= MAX_ROWS,
    })
  } catch (err) {
    // Most likely the tables don't exist yet (migration not run).
    console.error('[ops/transport] failed:', err)
    return NextResponse.json({ error: 'Transport metrics are not available yet (has the transport metrics migration run?).' }, { status: 503 })
  }
}

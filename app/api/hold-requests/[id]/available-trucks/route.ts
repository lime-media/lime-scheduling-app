import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { checkAvailability } from '@/lib/availabilityEngine'

/**
 * GET /api/hold-requests/[id]/available-trucks
 *
 * Trucks that could serve this reservation, for the swap picker.
 *
 * Every truck — including the one currently assigned — is evaluated on the SAME
 * basis, with this reservation's own hold excluded from the timelines so the
 * assigned truck does not block itself.
 *
 * The market reported is where the truck will DEPART FROM for these dates, not
 * where it happens to be today. Those differ whenever a truck has a commitment
 * between now and the campaign, which is exactly when the distinction matters.
 */
export async function GET(
  _req: NextRequest,
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

  const startDate = hold.start_date.toISOString().split('T')[0]
  const endDate = hold.end_date.toISOString().split('T')[0]

  const result = await checkAvailability({
    market: hold.market,
    startDate,
    endDate,
    truckCount: 1,
    excludeHoldId: hold.id,
  })

  const trucks = result.trucks.map(t => ({
    truckNumber: t.truckNumber,
    current: t.truckNumber === hold.truck_number,

    /** Where this truck departs from for these dates. */
    departsFrom: t.chain.inbound.originLabel,
    /**
     * True when departsFrom comes from a program or hold the truck is already
     * committed to, so it is a projection rather than a present-tense fact.
     * False means it came from live GPS.
     */
    originIsCommitment: t.chain.inbound.originIsPriorJob,
    /** Live GPS market, shown only to explain a difference. */
    gpsMarket: t.currentMarket || null,

    distanceMiles: t.distanceMiles,
    needsTransport: t.transport.needed,
    transportDays: t.transport.transportDays,
    transportCharge: t.transport.chargePerTruck,
    requiresOverride: t.requiresOverride,
  }))

  // Current truck first, then cheapest chain (checkAvailability already sorted).
  trucks.sort((a, b) => Number(b.current) - Number(a.current))

  return NextResponse.json({
    trucks,
    campaignMarket: hold.market,
    excluded: result.infeasible.map(t => ({
      truckNumber: t.truckNumber,
      reason: t.reason,
      detail: t.detail,
    })),
  })
}

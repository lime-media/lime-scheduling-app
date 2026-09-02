import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { checkAvailability } from '@/lib/availabilityEngine'

/**
 * GET /api/hold-requests/[id]/available-trucks
 *
 * Returns trucks available in the same market & date range as the given
 * hold request, for the truck-swap picker on the Reservations page.
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
  })

  const currentTruck = hold.truck_number
  const otherTrucks = result.trucks.filter(t => t.truckNumber !== currentTruck)

  const trucks = [
    { truckNumber: currentTruck, currentMarket: hold.market, distanceMiles: 0, current: true },
    ...otherTrucks.map(t => ({
      truckNumber: t.truckNumber,
      currentMarket: t.currentMarket,
      distanceMiles: t.distanceMiles,
      current: false,
    })),
  ]

  return NextResponse.json({ trucks })
}

import { NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { prisma } from '@/lib/prisma'
import { SERVICE_AREA_RADIUS_MILES } from '@/lib/pricing'

export async function GET(request: Request) {
  const authError = validateInternalApiKey(request)
  if (authError) return authError

  try {
    const markets = await prisma.acceptedMarket.findMany({
      where: { is_active: true },
      orderBy: { dma_name: 'asc' },
      select: {
        dma_code: true,
        dma_name: true,
        lat: true,
        lng: true,
        notes: true,
      },
    })

    return NextResponse.json({
      accepted_markets: markets,
      service_area_radius_miles: SERVICE_AREA_RADIUS_MILES,
      count: markets.length,
    })
  } catch (error) {
    console.error('[v1/internal/accepted-markets] Error:', error)
    return NextResponse.json({ error: 'Failed to fetch accepted markets' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getClientSession } from '@/lib/clientAuth'
import { createHoldRequestForClient } from '@/lib/holdRequestService'
import { selectTrucksForHold } from '@/lib/availabilityEngine'
import { createOpportunity, isSfdcConfigured } from '@/lib/salesforceClient'

export async function GET(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const requests = await prisma.holdRequest.findMany({
    where:   { client_user_id: session.id },
    orderBy: { created_at: 'desc' },
  })

  return NextResponse.json({
    holdRequests: requests.map((r) => ({
      id:                r.id,
      truck_number:      r.truck_number,
      market:            r.market,
      state:             r.state ?? '',
      start_date:        r.start_date.toISOString().split('T')[0],
      end_date:          r.end_date.toISOString().split('T')[0],
      notes:             r.notes ?? '',
      status:            r.status,
      company_name:      session.companyName,
      pricing_tier:      r.pricing_tier ?? null,
      quoted_total:      r.quoted_total ?? null,
      daily_rate:        r.daily_rate ?? null,
      features:          r.features ?? null,
      truck_count:       r.truck_count ?? null,
      campaign_group_id: r.campaign_group_id ?? null,
      expires_at:        r.expires_at?.toISOString() ?? null,
      extension_until:   r.extension_until?.toISOString().split('T')[0] ?? null,
      extension_reason:  r.extension_reason ?? null,
    })),
  })
}

export async function POST(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()

    // New flow: auto-select trucks when truck_number is not provided.
    // The client sends market/dates/truck_count + pricing snapshot, and the
    // API picks the optimal trucks via the availability engine.
    if (!body.truck_number && body.market && body.start_date && body.end_date && body.truck_count) {
      return handleAutoSelectHold(req, session, body)
    }

    // Legacy flow: client provides a specific truck_number (drag-on-grid)
    const { truck_number, market, state, start_date, end_date, notes } = body
    if (!truck_number || !start_date || !end_date) {
      return NextResponse.json({ error: 'truck_number, start_date, end_date required' }, { status: 400 })
    }

    const holdRequest = await createHoldRequestForClient(session, {
      truck_number, market, state, start_date, end_date, notes,
    })

    return NextResponse.json({ ok: true, id: holdRequest.id })
  } catch (e) {
    console.error('[client/hold-requests POST]', e)
    return NextResponse.json({ error: 'Failed to create hold request' }, { status: 500 })
  }
}

/**
 * Auto-select trucks and create hold requests for a campaign.
 * Used by the interactive quote card — the client never picks truck numbers.
 */
async function handleAutoSelectHold(
  _req: NextRequest,
  session: Awaited<ReturnType<typeof getClientSession>> & {},
  body: {
    market: string
    state?: string
    start_date: string
    end_date: string
    truck_count: number
    notes?: string
    pricing_tier?: string
    quoted_total?: number
    daily_rate?: number
    features?: string
    transport_charge?: number
  },
) {
  const {
    market, state, start_date, end_date, truck_count, notes,
    pricing_tier, quoted_total, daily_rate, features, transport_charge,
  } = body

  if (truck_count < 1 || truck_count > 20) {
    return NextResponse.json({ error: 'truck_count must be between 1 and 20' }, { status: 400 })
  }

  // Select optimal trucks via availability engine
  const { selectedTrucks, availability } = await selectTrucksForHold({
    market,
    startDate: start_date,
    endDate: end_date,
    truckCount: truck_count,
  })

  if (selectedTrucks.length === 0) {
    return NextResponse.json({
      error: 'No trucks available for the requested dates and market.',
    }, { status: 409 })
  }

  // Generate campaign group ID to link all trucks in this hold
  const campaignGroupId = `cg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  // Extract state from market if not provided (e.g. "Dallas, TX" → "TX")
  const resolvedState = state || market.split(',')[1]?.trim() || null

  const created: string[] = []
  const failed: string[] = []

  for (const truck of selectedTrucks) {
    try {
      await createHoldRequestForClient(session, {
        truck_number: truck.truckNumber,
        market,
        state: resolvedState,
        start_date,
        end_date,
        notes: notes ?? null,
        pricing_tier: pricing_tier ?? null,
        quoted_total: quoted_total ?? null,
        daily_rate: daily_rate ?? null,
        features: features ?? null,
        truck_count: selectedTrucks.length,
        campaign_group_id: campaignGroupId,
      })
      created.push(truck.truckNumber)
    } catch (err) {
      console.error('[client/hold-requests] failed to create hold for truck:', truck.truckNumber, err)
      failed.push(truck.truckNumber)
    }
  }

  if (created.length === 0) {
    return NextResponse.json({ error: 'Failed to create hold requests' }, { status: 500 })
  }

  // Create Salesforce Opportunity if the client has an SFDC Account ID
  let sfdcOpportunityId: string | null = null
  if (session.sfdcAccountId && isSfdcConfigured() && created.length > 0) {
    try {
      const oppName = `${session.companyName} - ${market} - ${start_date} to ${end_date}`
      const expiresAt = await prisma.holdRequest.findFirst({
        where: { campaign_group_id: campaignGroupId },
        select: { expires_at: true },
      })

      const result = await createOpportunity({
        accountId: session.sfdcAccountId,
        name: oppName,
        stageName: 'WARM',
        closeDate: start_date,
        amount: quoted_total ?? undefined,
        market,
        holdStart: start_date,
        holdStop: end_date,
        holdExp: expiresAt?.expires_at?.toISOString().split('T')[0],
        truckNumbers: created,
        ledRevenue: quoted_total ?? undefined,
      })

      if (result.success && result.id) {
        sfdcOpportunityId = result.id
        // Link the opportunity back to all hold requests in this campaign group
        await prisma.holdRequest.updateMany({
          where: { campaign_group_id: campaignGroupId },
          data: { sfdc_opportunity_id: result.id },
        })
      } else {
        console.error('[client/hold-requests] SFDC opportunity creation failed:', result.errors)
      }
    } catch (err) {
      // SFDC failure should never block the hold — log and continue
      console.error('[client/hold-requests] SFDC opportunity creation error:', err)
    }
  }

  return NextResponse.json({
    ok: true,
    created: created.length,
    failed: failed.length,
    campaignGroupId,
    trucksRequested: truck_count,
    trucksAvailable: availability.counts.total,
    message: `Submitted ${created.length} hold request${created.length > 1 ? 's' : ''} for review. Holds expire in 72 hours.`,
  })
}

/**
 * POST /api/quote/hold
 *
 * Internal hold placement — staff creates a hold on behalf of a client.
 * Requires a sfdc_account_id to create the Salesforce Opportunity.
 * Uses the availability engine to auto-select trucks.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { prisma } from '@/lib/prisma'
import { selectTrucksForHold } from '@/lib/availabilityEngine'
import { computeHoldExpiresAt } from '@/lib/holdRequestService'
import { createOpportunity, isSfdcConfigured } from '@/lib/salesforceClient'
import { parseQuoteFeatures, buildActivationNotes } from '@/lib/quoteFeatures'

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const {
    market, state, start_date, end_date, truck_count,
    sfdc_account_id, sfdc_account_name,
    pricing_tier, quoted_total, daily_rate, features, transport_charge,
  } = body

  if (!market || !start_date || !end_date || !truck_count) {
    return NextResponse.json({ error: 'market, start_date, end_date, truck_count required' }, { status: 400 })
  }

  if (!sfdc_account_id) {
    return NextResponse.json({ error: 'A Salesforce Account must be selected' }, { status: 400 })
  }

  // Select optimal trucks
  const { selectedTrucks } = await selectTrucksForHold({
    market,
    startDate: start_date,
    endDate: end_date,
    truckCount: truck_count,
  })

  if (selectedTrucks.length === 0) {
    return NextResponse.json({ error: 'No trucks available' }, { status: 409 })
  }

  const campaignGroupId = `cg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const resolvedState = state || market.split(',')[1]?.trim() || null
  const expiresAt = computeHoldExpiresAt(start_date)

  // Find a ClientUser linked to this SFDC Account if one exists.
  // Internal holds don't require a ClientUser — client_user_id is nullable.
  const linkedClient = await prisma.clientUser.findFirst({
    where: { sfdc_account_id: sfdc_account_id },
    select: { id: true },
  })

  // Create hold requests
  const created: string[] = []
  for (const truck of selectedTrucks) {
    try {
      await prisma.holdRequest.create({
        data: {
          client_user_id: linkedClient?.id ?? null,
          truck_number: truck.truckNumber,
          market,
          state: resolvedState,
          start_date: new Date(start_date),
          end_date: new Date(end_date),
          status: 'PENDING',
          source: 'INTERNAL',
          pricing_tier: pricing_tier ?? null,
          quoted_total: quoted_total ?? null,
          daily_rate: daily_rate ?? null,
          features: features ?? null,
          truck_count: selectedTrucks.length,
          campaign_group_id: campaignGroupId,
          expires_at: expiresAt,
          notes: `Internal quote for ${sfdc_account_name || 'Unknown'}`,
        },
      })
      created.push(truck.truckNumber)
    } catch (err) {
      console.error('[quote/hold] failed to create hold for truck:', truck.truckNumber, err)
    }
  }

  if (created.length === 0) {
    return NextResponse.json({ error: 'Failed to create hold requests' }, { status: 500 })
  }

  // Create Salesforce Opportunity
  let sfdcOpportunityId: string | null = null
  if (isSfdcConfigured()) {
    try {
      const parsedFeatures = parseQuoteFeatures(features)
      const activationNotes = parsedFeatures
        ? buildActivationNotes(parsedFeatures, pricing_tier)
        : undefined

      const result = await createOpportunity({
        accountId: sfdc_account_id,
        name: `${sfdc_account_name || 'Client'} - ${market} - ${start_date} to ${end_date}`,
        stageName: 'WARM',
        closeDate: start_date,
        amount: quoted_total ?? undefined,
        market,
        holdStart: start_date,
        holdStop: end_date,
        holdExp: expiresAt.toISOString().split('T')[0],
        truckNumbers: created,
        activationNotes,
      })

      if (result.success && result.id) {
        sfdcOpportunityId = result.id
        await prisma.holdRequest.updateMany({
          where: { campaign_group_id: campaignGroupId },
          data: { sfdc_opportunity_id: result.id },
        })
      } else {
        console.error('[quote/hold] SFDC opportunity creation failed:', result.errors)
      }
    } catch (err) {
      console.error('[quote/hold] SFDC opportunity creation error:', err)
    }
  }

  return NextResponse.json({
    ok: true,
    created: created.length,
    campaignGroupId,
    sfdcOpportunityId,
    message: `Created ${created.length} hold request${created.length > 1 ? 's' : ''} for ${sfdc_account_name || 'client'}. ${sfdcOpportunityId ? 'Salesforce opportunity created.' : ''}`,
  })
}

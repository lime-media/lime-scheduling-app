/**
 * POST /api/quote/hold
 *
 * Internal hold placement — staff creates a hold on behalf of a client.
 * Requires a sfdc_account_id to create the Salesforce Opportunity.
 * Uses the availability engine to auto-select trucks.
 */

import { QUOTE_ONLY_NO_TRUCK, QUOTE_ONLY_NOTE, QUOTE_ONLY_ORIGINATION, QUOTE_ONLY_STATUS } from '@/lib/quoteOnly'
import { openStage } from '@/lib/sfdcStages'
import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { prisma } from '@/lib/prisma'
import { canonicalMarketName } from '@/lib/marketBounds'
import { selectTrucksForHold, legsFromTrucks } from '@/lib/availabilityEngine'
import { computeHoldExpiresAt } from '@/lib/holdExpiry'
import { createOpportunity, getSfdcAccountInfo, isSfdcConfigured, resolveOpportunityOwner } from '@/lib/salesforceClient'
import { brandMarkupFor } from '@/lib/pricing/brandMarkup'
import { parseQuoteFeatures, buildActivationNotes } from '@/lib/quoteFeatures'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'
import {
  computeQuote,
  priceTransport,
  countActivationDays,
  countCalendarDays,
  defaultDaysPerWeek,
  VALID_STUDIES,
  type StudyType,
} from '@/lib/pricing'
import { resolveMarketSizeTierId, resolveRateOverridesBySfdcAccount, resolveDefaultRateOverrides } from '@/lib/pricing/resolvers'
import type { RateOverrides } from '@/lib/pricing/config'

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const {
    market, state, start_date, end_date, truck_count,
    sfdc_account_id, sfdc_account_name,
    shadow_fencing, smart_directional, device_id, studies: rawStudies,
    days_per_week, operating_hours, brand_markup_pct, stage, quote_only, expected_total,
  } = body
  // Low conviction: log a priced opportunity, reserve nothing (lib/quoteOnly.ts).
  const quoteOnly = quote_only === true

  if (!market || !start_date || !end_date || !truck_count) {
    return NextResponse.json({ error: 'market, start_date, end_date, truck_count required' }, { status: 400 })
  }

  if (!sfdc_account_id) {
    return NextResponse.json({ error: 'A Salesforce Account must be selected' }, { status: 400 })
  }

  // Resolve rate overrides first — service_area_miles affects truck selection
  const defaultOverrides = await resolveDefaultRateOverrides()
  let rateOverrides: RateOverrides | undefined = defaultOverrides ?? undefined
  if (sfdc_account_id) {
    const result = await resolveRateOverridesBySfdcAccount(sfdc_account_id)
    if (result.overrides) {
      rateOverrides = { ...rateOverrides, ...result.overrides }
      if (result.overrides.daily_rates) {
        rateOverrides.daily_rates = { ...rateOverrides?.daily_rates, ...result.overrides.daily_rates }
      }
    }
  }

  // Select optimal trucks (with custom service area if set)
  const { selectedTrucks, availability } = await selectTrucksForHold({
    market,
    startDate: start_date,
    endDate: end_date,
    truckCount: truck_count,
    serviceAreaMiles: rateOverrides?.service_area_miles,
  })

  // A quote-only log reserves nothing, so it goes through even when no truck
  // is free — that is exactly the low-conviction case it exists for.
  if (selectedTrucks.length === 0 && !quoteOnly) {
    return NextResponse.json({ error: 'No trucks available' }, { status: 409 })
  }

  const campaignGroupId = `cg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const resolvedState = state || market.split(',')[1]?.trim() || null
  const expiresAt = computeHoldExpiresAt(start_date)

  // ── Server-side price recomputation ──────────────────────────────────────
  const calendarDays = countCalendarDays(start_date, end_date)
  const dpw = days_per_week ?? defaultDaysPerWeek(calendarDays)
  const opHours = operating_hours ?? 8
  const activationDays = countActivationDays(start_date, end_date, dpw)

  const includeSF = shadow_fencing !== false
  const includeSD = smart_directional ?? false
  const includeDID = device_id ?? false
  const studies = (rawStudies ?? [])
    .map((s: string) => s.trim().toLowerCase())
    .filter((s: string): s is StudyType => (VALID_STUDIES as readonly string[]).includes(s))

  // Brand Direct: folded into every price by the engine — only when
  // Salesforce says the account is Brand Direct (the browser's word is not
  // enough). The seller's percentage is kept to 0-50%; it starts at 10%.
  const accountInfo = sfdc_account_id && isSfdcConfigured()
    ? await getSfdcAccountInfo(sfdc_account_id).catch((err) => { console.error('[quote/hold] account lookup failed:', err); return null })
    : null
  const markupPct = brandMarkupFor(accountInfo?.clientType, brand_markup_pct)

  const marketSizeTierId = await resolveMarketSizeTierId(market)
  const quote = computeQuote({
    truckCount: truck_count, days: activationDays, operatingHours: opHours,
    marketSizeTierId, includeSmartDirectional: includeSD, includeDeviceId: includeDID, studies,
    rateOverrides, markupPct,
  })

  let mediaTotal = quote.good.baseMedia
  if (includeSF) mediaTotal += quote.better.shadowFencing
  if (includeSD) mediaTotal += quote.better.smartDirectional
  if (includeDID) mediaTotal += quote.better.deviceId
  if (quote.best.reachOk && studies.length > 0) mediaTotal += studies.length * quote.best.studyCost

  const transport = priceTransport({
    activationDays,
    leadBusinessDays: availability.campaignFlags.leadBusinessDays,
    legs: legsFromTrucks(selectedTrucks),
    transportIncluded: rateOverrides?.transport_included,
    overrides: {
      dayRate: rateOverrides?.transport_day_rate,
      airfare: rateOverrides?.transport_airfare,
      hotelPerNight: rateOverrides?.transport_hotel_per_night,
    },
    markupPct,
  })

  const transportCharge = transport.charge
  const serverTotal = mediaTotal + transportCharge

  // The price the rep saw must be the price booked (the Brand Direct markup
  // or the fleet may have changed since the quote was shown).
  if (typeof expected_total === 'number' && Math.abs(serverTotal - expected_total) >= 1) {
    return NextResponse.json({
      error: 'The price changed since the quote was shown.',
      priceChanged: { was: expected_total, now: Math.round(serverTotal * 100) / 100 },
    }, { status: 409 })
  }

  let pricingTier = 'Custom'
  if (!includeSF && !includeSD && !includeDID && studies.length === 0) pricingTier = 'Good'
  else if (includeSF && !includeSD && !includeDID && studies.length === 0) pricingTier = 'Better'
  else if (includeSF && studies.length > 0 && quote.best.reachOk) pricingTier = 'Best'

  // Deadhead this booking imposes on each truck's NEXT job. Recorded with the
  // reservation and returned so it is visible when the hold is placed — not
  // billed, and not re-rating the successor's own quote.
  const successorImpact = selectedTrucks
    .filter(t => t.chain.successor && !t.chain.successor.unresolvedMarket
      && (t.chain.successor.deltaTransportDays !== 0 || t.chain.successor.deltaCost !== 0))
    .map(t => ({
      truckNumber: t.truckNumber,
      successorMarket: t.chain.successor!.market,
      successorStart: t.chain.successor!.startsOn,
      deltaTransportDays: t.chain.successor!.deltaTransportDays,
      deltaCost: Math.round(t.chain.successor!.deltaCost),
    }))

  const featuresJson = JSON.stringify({
    dailyRate: quote.dailyRate, hourSurcharge: quote.hourSurcharge,
    truckDays: quote.input.truckDays, truckCount: truck_count,
    activationDays, calendarDays, daysPerWeek: dpw, operatingHours: opHours,
    baseMedia: quote.good.baseMedia,
    shadowFencing: includeSF ? quote.better.shadowFencing : 0,
    shadowFencingFloored: quote.better.shadowFencingFloored,
    smartDirectionalIncluded: includeSD, smartDirectional: includeSD ? quote.better.smartDirectional : 0,
    deviceIdIncluded: includeDID, deviceId: includeDID ? quote.better.deviceId : 0,
    studies, studyCost: quote.best.studyCost,
    studiesTotal: quote.best.reachOk ? studies.length * quote.best.studyCost : 0,
    transportCharge,
    successorImpact,
  })

  // Find a ClientUser linked to this SFDC Account if one exists.
  const linkedClient = await prisma.clientUser.findFirst({
    where: { sfdc_account_id: sfdc_account_id },
    select: { id: true },
  })

  // Resolve the service user for Hold.created_by (FK to app_users)
  const serviceUser = await prisma.user.findFirst({
    where: { email: SFDC_SERVICE_USER_EMAIL },
    select: { id: true },
  })
  const createdBy = (token.id as string) || serviceUser?.id || 'system'

  // Create holds directly (unified — no more dual-write to HoldRequest)
  // Canonical market name — see canonicalMarketName().
  const canonicalMarket = (await canonicalMarketName(market, resolvedState ?? undefined)) ?? market

  const created: string[] = []
  // Quote only with no truck free: still one record of what was quoted.
  const recordTrucks: { truckNumber: string }[] = quoteOnly && selectedTrucks.length === 0 ? [{ truckNumber: QUOTE_ONLY_NO_TRUCK }] : selectedTrucks
  for (const truck of recordTrucks) {
    try {
      await prisma.hold.create({
        data: {
          truck_number:      truck.truckNumber,
          client_name:       sfdc_account_name || 'Unknown',
          market:            canonicalMarket,
          state:             resolvedState ?? '',
          start_date:        new Date(start_date),
          end_date:          new Date(end_date),
          status:            quoteOnly ? QUOTE_ONLY_STATUS : 'HOLD',
          source:            'INTERNAL',
          origination:       quoteOnly ? QUOTE_ONLY_ORIGINATION : 'frontend',
          notes:             quoteOnly ? `${QUOTE_ONLY_NOTE} Internal quote for ${sfdc_account_name || 'Unknown'}` : `Internal quote for ${sfdc_account_name || 'Unknown'}`,
          created_by:        createdBy,
          // Quote-only logs are internal: never shown in the client portal.
          client_user_id:    quoteOnly ? null : linkedClient?.id ?? null,
          pricing_tier:      pricingTier,
          quoted_total:      serverTotal,
          daily_rate:        quote.dailyRate,
          features:          featuresJson,
          truck_count:       quoteOnly ? truck_count : selectedTrucks.length,
          campaign_group_id: campaignGroupId,
          expires_at:        quoteOnly ? new Date() : expiresAt,
        },
      })
      created.push(truck.truckNumber)
    } catch (err) {
      console.error('[quote/hold] failed to create hold for truck:', truck.truckNumber, err)
    }
  }

  if (created.length === 0) {
    return NextResponse.json({ error: 'Failed to create holds' }, { status: 500 })
  }

  // Create Salesforce Opportunity
  let sfdcOpportunityId: string | null = null
  let sfdcError: string | null = null
  if (isSfdcConfigured()) {
    try {
      const parsedFeatures = parseQuoteFeatures(featuresJson)
      const activationNotes = parsedFeatures
        ? buildActivationNotes(parsedFeatures, pricingTier)
        : undefined

      // Owned by the rep who booked it (matched by email), else the account owner.
      const owner = await resolveOpportunityOwner({ creatorEmail: token.email as string | undefined, accountOwnerId: accountInfo?.ownerId })
      const result = await createOpportunity({
        accountId: sfdc_account_id,
        ownerId: owner.ownerId ?? undefined,
        clientType: accountInfo?.clientType,
        // Internal record only (Salesforce): every price above already includes it.
        description: [
          quoteOnly ? `Quote only (low conviction): no trucks reserved. ${truck_count} truck${truck_count === 1 ? '' : 's'} quoted, ${start_date} to ${end_date}`
            + (selectedTrucks.length ? `, priced on ${selectedTrucks.map(t => t.truckNumber).join(', ')}.` : '; no truck was available, so transport is not priced.') : null,
          markupPct ? `Brand Direct pricing: +${markupPct}% folded into every line item.` : null,
        ].filter(Boolean).join('\n') || undefined,
        name: `${sfdc_account_name || 'Client'} - ${market} - ${start_date} to ${end_date}`,
        // The seller's choice of open stage; never a closed one.
        stageName: openStage(stage),
        closeDate: start_date,
        amount: serverTotal,
        market,
        // Quote only: no LED truck / hold fields — Salesforce would turn them
        // back into reservations. The priced trucks and dates go in the Description.
        ...(quoteOnly ? {} : {
          holdStart: start_date,
          holdStop: end_date,
          holdExp: expiresAt.toISOString().split('T')[0],
          truckNumbers: created,
        }),
        activationNotes,
      })

      if (result.success && result.id) {
        sfdcOpportunityId = result.id
        await prisma.hold.updateMany({
          where: { campaign_group_id: campaignGroupId },
          data: { sfdc_opportunity_id: result.id },
        })
      } else {
        sfdcError = 'Salesforce rejected the opportunity'
        console.error('[quote/hold] SFDC opportunity creation failed:', result.errors)
      }
    } catch (err) {
      sfdcError = 'Salesforce could not be reached'
      console.error('[quote/hold] SFDC opportunity creation error:', err)
    }
  }

  // Never silent: if the opportunity was not created, the rep is told.
  const sfdcNote = sfdcOpportunityId ? 'Salesforce opportunity created.'
    : sfdcError ? `${sfdcError}: no opportunity was created. Create it in Salesforce by hand.`
    : ''
  return NextResponse.json({
    ok: true,
    sfdcError,
    created: created.length,
    campaignGroupId,
    sfdcOpportunityId,
    quoteOnly,
    message: quoteOnly
      ? `Quote logged for ${sfdc_account_name || 'client'}; no trucks reserved.${selectedTrucks.length ? '' : ' No truck was free, so transport is not priced.'} ${sfdcNote}`
      : `Reserved ${created.length} truck${created.length > 1 ? 's' : ''} for ${sfdc_account_name || 'client'}. ${sfdcNote}`,
    _internal: {
      chainFlags: successorImpact,
      _warning: 'INTERNAL ONLY — downstream deadhead, recorded not billed',
    },
  })
}

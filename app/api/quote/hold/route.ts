/**
 * POST /api/quote/hold
 *
 * Internal hold placement — staff creates a hold on behalf of a client.
 * Requires a sfdc_account_id to create the Salesforce Opportunity.
 * Uses the availability engine to auto-select trucks.
 */

import { withUsageLog } from '@/lib/usageLog'
import { cleanBrand, opportunityName } from '@/lib/brand'
import { QUOTE_ONLY_NO_TRUCK, QUOTE_ONLY_NOTE, QUOTE_ONLY_ORIGINATION, QUOTE_ONLY_STATUS } from '@/lib/quoteOnly'
import { openStage } from '@/lib/sfdcStages'
import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { prisma } from '@/lib/prisma'
import { canonicalMarketName } from '@/lib/marketBounds'
import { selectTrucksForHold, legsFromTrucks } from '@/lib/availabilityEngine'
import { holdExpiry, parseHoldDays, MAX_HOLD_DAYS, STAFF_MIN_DAYS_BEFORE_START } from '@/lib/holdExpiry'
import { createOpportunity, getSfdcAccountInfo, isSfdcConfigured, checkPrimaryContact, resolveOpportunityOwner } from '@/lib/salesforceClient'
import { AMOUNT_LEFT_NOTE, WINDOW_LEFT_NOTE, applyBookingToOpportunity, getBookingOpportunity, opportunityRefusal, type BookingOpportunity } from '@/lib/sfdcBooking'
import { brandMarkupFor } from '@/lib/pricing/brandMarkup'
import { parseQuoteFeatures, buildActivationNotes } from '@/lib/quoteFeatures'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'
import {
  computeQuote,
  priceTransport,
  countActivationDays,
  countCalendarDays,
  billedDaysPerWeek,
  VALID_STUDIES,
  type StudyType,
} from '@/lib/pricing'
import { resolveMarketSizeTierId, resolveRateOverridesBySfdcAccount, resolveDefaultRateOverrides } from '@/lib/pricing/resolvers'
import type { RateOverrides } from '@/lib/pricing/config'
import { recordBooking } from '@/lib/transportMetricsRecord'
import { legsFromSelectedTrucks } from '@/lib/transportMetrics'

async function handlePost(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const {
    market, state, start_date, end_date, truck_count,
    sfdc_account_id, sfdc_account_name, brand: rawBrand, primary_contact_id,
    shadow_fencing, smart_directional, device_id, studies: rawStudies,
    days_per_week, operating_hours, brand_markup_pct, stage, quote_only, expected_total, hold_days,
    attach_opportunity_id,
  } = body
  // How long the seller is holding the trucks (default 3 days; lib/holdExpiry.ts).
  const holdDays = parseHoldDays(hold_days)
  // Low conviction: log a priced opportunity, reserve nothing (lib/quoteOnly.ts).
  const quoteOnly = quote_only === true
  // The brand, as Salesforce gets it (Brand / Job Name, and first in the name).
  const brand = cleanBrand(typeof rawBrand === 'string' ? rawBrand : '')

  if (!market || !start_date || !end_date || !truck_count) {
    return NextResponse.json({ error: 'market, start_date, end_date, truck_count required' }, { status: 400 })
  }

  if (!sfdc_account_id) {
    return NextResponse.json({ error: 'A Salesforce Account must be selected' }, { status: 400 })
  }
  if (holdDays === null) {
    return NextResponse.json({ error: `Hold for 1 to ${MAX_HOLD_DAYS} days.` }, { status: 400 })
  }
  // Every opportunity needs its primary contact, on this account. A definite
  // no refuses; Salesforce being unreachable only warns (see checkPrimaryContact).
  const contact = await checkPrimaryContact(primary_contact_id, sfdc_account_id)
  if (contact.refusal) return NextResponse.json({ error: contact.refusal }, { status: 400 })
  const sfdcWarnings: string[] = contact.warning ? [contact.warning] : []

  // Adding this to an existing open opportunity of the account instead of
  // starting a new one (lib/sfdcBooking.ts): it must be the account's and not lost.
  let target: BookingOpportunity | null = null
  // Salesforce couldn't be reached to check it: the hold is still placed
  // (unlinked) and the rep is told to add it to the opportunity by hand.
  let attachUnreachable = false
  if (attach_opportunity_id) {
    if (!isSfdcConfigured()) return NextResponse.json({ error: 'Salesforce is not configured, so the opportunity cannot be updated.' }, { status: 503 })
    try {
      target = await getBookingOpportunity(String(attach_opportunity_id))
    } catch (err) {
      console.error('[quote/hold] opportunity read failed:', err)
      attachUnreachable = true
    }
    const refusal = attachUnreachable ? null : opportunityRefusal(target, sfdc_account_id)
    if (refusal) return NextResponse.json({ error: refusal }, { status: 409 })
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
    // Same rule as the staff quote, so the hold books the trucks it quoted.
    softHoldStrandIsWarning: true,
  })

  // A quote-only log reserves nothing, so it goes through even when no truck
  // is free — that is exactly the low-conviction case it exists for.
  if (selectedTrucks.length === 0 && !quoteOnly) {
    return NextResponse.json({ error: 'No trucks available' }, { status: 409 })
  }

  const campaignGroupId = `cg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const resolvedState = state || market.split(',')[1]?.trim() || null
  const { expiresAt, cappedByStart, atMinimum } = holdExpiry(start_date, holdDays, new Date(), STAFF_MIN_DAYS_BEFORE_START)

  // ── Server-side price recomputation ──────────────────────────────────────
  const calendarDays = countCalendarDays(start_date, end_date)
  const dpw = billedDaysPerWeek(start_date, end_date, days_per_week)
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
    // Added to an existing opportunity: lapsing never closes it (expiryClosesOpportunity).
    ...(target ? { attachedToOpportunity: true } : {}),
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
          // Never committed here: a Closed Won opportunity takes no additions (opportunityRefusal).
          status:            quoteOnly ? QUOTE_ONLY_STATUS : 'HOLD',
          source:            'INTERNAL',
          origination:       quoteOnly ? QUOTE_ONLY_ORIGINATION : 'frontend',
          notes:             `${quoteOnly ? `${QUOTE_ONLY_NOTE} ` : ''}Internal quote for ${sfdc_account_name || 'Unknown'}${brand ? ` (brand: ${brand})` : ''}`,
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
          sfdc_opportunity_id: target?.Id ?? null,
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
  if (attachUnreachable) {
    sfdcError = 'Salesforce could not be reached to add it to the opportunity'
  } else if (isSfdcConfigured()) {
    try {
      const parsedFeatures = parseQuoteFeatures(featuresJson)
      const activationNotes = parsedFeatures
        ? buildActivationNotes(parsedFeatures, pricingTier)
        : undefined

      if (target) {
        // Added to the account's existing opportunity: it grows (lib/opportunityMerge.ts ADD).
        const applied = await applyBookingToOpportunity({
          opp: target,
          mode: 'ADD',
          booking: {
            amount: serverTotal,
            markets: [market],
            trucks: created,
            ...(quoteOnly ? {} : { holdStart: start_date, holdStop: end_date, holdExp: expiresAt.toISOString().split('T')[0] }),
            description: `${market}: ${quoteOnly ? `quote only, ${truck_count} truck${truck_count === 1 ? '' : 's'} quoted` : `${created.length} truck${created.length === 1 ? '' : 's'} (${created.join(', ')})`}, ${start_date} to ${end_date}.`,
          },
          by: (token.name as string | undefined) || (token.email as string | undefined) || 'the app',
          primaryContactId: primary_contact_id,
        })
        if (applied.ok) sfdcOpportunityId = target.Id
        else sfdcError = 'Salesforce rejected the opportunity update'
        if (applied.ok && applied.amountLeft) sfdcWarnings.push(AMOUNT_LEFT_NOTE)
        if (applied.ok && applied.windowLeft) sfdcWarnings.push(WINDOW_LEFT_NOTE)
      } else {
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
        name: opportunityName(brand, sfdc_account_name || 'Client', `${market} - ${start_date} to ${end_date}`),
        brand: brand || undefined,
        primaryContactId: primary_contact_id,
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
        sfdcWarnings.push(...(result.warnings ?? []))
        await prisma.hold.updateMany({
          where: { campaign_group_id: campaignGroupId },
          data: { sfdc_opportunity_id: result.id },
        })
      } else {
        sfdcError = 'Salesforce rejected the opportunity'
        console.error('[quote/hold] SFDC opportunity creation failed:', result.errors)
      }
      }
    } catch (err) {
      sfdcError = 'Salesforce could not be reached'
      console.error('[quote/hold] SFDC opportunity creation error:', err)
    }
  }

  // Transport and deal-value metrics (best-effort; never fails the booking).
  if (!quoteOnly) await recordBooking({ event: 'BOOKED', groups: [{ groupId: campaignGroupId, legs: legsFromSelectedTrucks(selectedTrucks, transport) }], appQuotedTotal: serverTotal, createdBy })

  // Never silent: if the opportunity was not created, the rep is told.
  const sfdcNote = sfdcOpportunityId
    ? `${target ? `Added to Salesforce opportunity "${target.Name}".` : 'Salesforce opportunity created.'}${sfdcWarnings.length ? ` Check it: ${sfdcWarnings.join('; ')}.` : ''}`
    // An existing opportunity is updated by hand; creating one would duplicate it.
    : sfdcError ? (target || attachUnreachable
      ? `${sfdcError}. Update ${target ? `"${target.Name}"` : 'the opportunity you picked'} in Salesforce by hand with this booking.`
      : `${sfdcError}: no opportunity was created. Create it in Salesforce by hand.`)
    : ''
  const booked = quoteOnly
    ? `Quote logged for ${sfdc_account_name || 'client'}; no trucks reserved.${selectedTrucks.length ? '' : ' No truck was free, so transport is not priced.'}`
    : `Reserved ${created.length} truck${created.length > 1 ? 's' : ''} for ${sfdc_account_name || 'client'}, held until ${HELD_UNTIL.format(expiresAt)}`
      + (cappedByStart ? ` (${STAFF_MIN_DAYS_BEFORE_START} days before the campaign starts, the latest a hold can run)`
        : atMinimum ? ' (the 24-hour minimum: the campaign starts too soon for a longer hold)' : '') + '.'
  return NextResponse.json({
    ok: true,
    sfdcError,
    created: created.length,
    campaignGroupId,
    sfdcOpportunityId,
    quoteOnly,
    message: `${booked} ${sfdcNote}`,
    // The UI shows the booking and a Salesforce failure apart, so a failure
    // can't read as part of a success.
    confirmation: sfdcOpportunityId ? `${booked} ${sfdcNote}` : booked,
    sfdcFailure: sfdcOpportunityId ? null : sfdcNote || null,
    _internal: {
      chainFlags: successorImpact,
      _warning: 'INTERNAL ONLY — downstream deadhead, recorded not billed',
    },
  })
}

// Every run is logged for the Usage page (lib/usageLog.ts).
export const POST = withUsageLog('hold_classic', 'staff', handlePost)

/** When a hold lapses, as the rep reads it (Central time). */
const HELD_UNTIL = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago', timeZoneName: 'short' })

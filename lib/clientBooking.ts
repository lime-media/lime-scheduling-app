/**
 * The client booking: the client portal's "place hold" (POST
 * /api/client/hold-requests with a market and truck count), moved out of its
 * route so other client surfaces book through the same code: the engine picks
 * the trucks, the price is recomputed server-side, and the Salesforce
 * opportunity is created. Returns the route's status and JSON body.
 */

import { cleanBrand, opportunityName } from '@/lib/brand'
import { DEFAULT_STAGE } from '@/lib/sfdcStages'
import { brandMarkupFor } from '@/lib/pricing/brandMarkup'
import { prisma } from '@/lib/prisma'
import type { ClientSession } from '@/lib/clientAuth'
import { ClientHoldRefusal, createClientHolds } from '@/lib/holdRequestService'
import { HoldClashError, HoldLockTimeoutError } from '@/lib/holdWriteLock'
import { sendHoldRequestEmail } from '@/lib/email'
import { selectTrucksForHold, legsFromTrucks } from '@/lib/availabilityEngine'
import { createOpportunity, isSfdcConfigured, getSfdcAccountInfo } from '@/lib/salesforceClient'
import { parseQuoteFeatures, buildActivationNotes } from '@/lib/quoteFeatures'
import { recordBooking } from '@/lib/transportMetricsRecord'
import { legsFromSelectedTrucks } from '@/lib/transportMetrics'
import {
  computeQuote,
  priceTransport,
  countActivationDays,
  countCalendarDays,
  daysUntil,
  MIN_CLIENT_LEAD_DAYS,
  billedDaysPerWeek,
  VALID_STUDIES,
  type StudyType,
} from '@/lib/pricing'
import { resolveMarketSizeTierId, resolveRateOverrides, resolveDefaultRateOverrides } from '@/lib/pricing/resolvers'
import { liveClientLinks } from '@/lib/clientLinks'
import { holdExpDate } from '@/lib/dateOnly'
import { reply, type CoreResult } from '@/lib/coreResult'

export type ClientBookingInput = {
  market: string
  state?: string
  start_date: string
  end_date: string
  truck_count: number
  notes?: string
  shadow_fencing?: boolean
  smart_directional?: boolean
  device_id?: boolean
  studies?: string[]
  days_per_week?: number
  operating_hours?: number
  /** Optional brand; cleaned before it goes to Salesforce (lib/brand.ts). */
  brand?: string
}

/**
 * Auto-select trucks and create holds for a campaign.
 *
 * IMPORTANT: All pricing is recomputed server-side from market/dates/truck_count
 * and the client's feature selections. Client-sent quoted_total/daily_rate values
 * are ignored — the trust boundary is the HTTP request, not the UI.
 */
export async function placeClientBooking(
  session: ClientSession,
  body: ClientBookingInput,
): Promise<CoreResult> {
  const {
    market, state, start_date, end_date, truck_count, notes,
  } = body
  const brand = cleanBrand(body.brand)

  // A whole number, as the quote requires (lib/clientAvailability.ts): 2.5,
  // "2" or true would hold one count of trucks and bill another.
  if (typeof truck_count !== 'number' || !Number.isInteger(truck_count) || truck_count < 1 || truck_count > 20) {
    return reply({ error: 'truck_count must be between 1 and 20' }, { status: 400 })
  }

  // Same policy as the client quote (lib/clientQuote.ts) — enforced here too so
  // the hold cannot be placed by calling the booking endpoint directly.
  const leadDays = daysUntil(start_date)
  if (leadDays < MIN_CLIENT_LEAD_DAYS) {
    return reply({
      error: leadDays < 0
        ? 'That start date has already passed.'
        : `Campaigns starting within ${MIN_CLIENT_LEAD_DAYS} days can't be booked online. Submit a request and the Lime Media team will follow up.`,
      rushBlocked: true,
    }, { status: 409 })
  }

  // Resolved before selection: a custom service_area_miles changes WHICH trucks
  // need repositioning, so selecting first and applying the override afterwards
  // makes the hold disagree with the quote the client just accepted.
  // The client's agreement over the editable default rate card, merged exactly
  // as the quote merges them (lib/clientAvailability.ts), so the booking is
  // priced and picked on the rates the client was just quoted.
  const [marketSizeTierId, clientOverrides, defaultOverrides] = await Promise.all([
    resolveMarketSizeTierId(market),
    resolveRateOverrides(session),
    resolveDefaultRateOverrides(),
  ])
  const rateOverrides = clientOverrides
    ? { ...defaultOverrides, ...clientOverrides, daily_rates: { ...defaultOverrides?.daily_rates, ...clientOverrides.daily_rates } }
    : defaultOverrides

  const { selectedTrucks, availability } = await selectTrucksForHold({
    market,
    startDate: start_date,
    endDate: end_date,
    truckCount: truck_count,
    serviceAreaMiles: rateOverrides?.service_area_miles,
  })

  if (selectedTrucks.length === 0) {
    return reply({
      error: 'No trucks available for the requested dates and market.',
    }, { status: 409 })
  }
  // Fewer trucks free now than the quote was for: refused, not booked short.
  // The price (and the Salesforce Amount) is for truck_count trucks.
  if (selectedTrucks.length < truck_count) {
    return reply({
      error: `Only ${selectedTrucks.length} of the ${truck_count} trucks are available for these dates now. Nothing was booked. Get a fresh quote.`,
    }, { status: 409 })
  }

  // ── Server-side price recomputation ──────────────────────────────────────
  const calendarDays = countCalendarDays(start_date, end_date)
  const daysPerWeek = billedDaysPerWeek(start_date, end_date, body.days_per_week)
  const operatingHours = body.operating_hours ?? 8
  const activationDays = countActivationDays(start_date, end_date, daysPerWeek)

  const includeShadowFencing = body.shadow_fencing !== false
  const includeSmartDirectional = body.smart_directional ?? false
  const includeDeviceId = body.device_id ?? false
  const studies = (body.studies ?? [])
    .map(s => s.trim().toLowerCase())
    .filter((s): s is StudyType => (VALID_STUDIES as readonly string[]).includes(s))

  // Brand Direct accounts are priced with the markup folded into every price,
  // at the default rate (clients cannot change it and never see it).
  // Read from the client's row, not the session's 30-day-old copy, so an ops
  // relink reaches the next booking rather than the next login.
  const { sfdcAccountId } = await liveClientLinks(session)
  const accountInfo = sfdcAccountId && isSfdcConfigured()
    ? await getSfdcAccountInfo(sfdcAccountId).catch(() => null)
    : null
  const markupPct = brandMarkupFor(accountInfo?.clientType)

  const quote = computeQuote({
    truckCount: truck_count,
    days: activationDays,
    operatingHours,
    marketSizeTierId,
    includeSmartDirectional,
    includeDeviceId,
    studies,
    rateOverrides,
    markupPct,
  })

  let mediaTotal = quote.good.baseMedia
  if (includeShadowFencing) mediaTotal += quote.better.shadowFencing
  if (includeSmartDirectional) mediaTotal += quote.better.smartDirectional
  if (includeDeviceId) mediaTotal += quote.better.deviceId
  if (quote.best.reachOk && studies.length > 0) {
    mediaTotal += studies.length * quote.best.studyCost
  }

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

  let pricingTier = 'Custom'
  if (!includeShadowFencing && !includeSmartDirectional && !includeDeviceId && studies.length === 0) pricingTier = 'Good'
  else if (includeShadowFencing && !includeSmartDirectional && !includeDeviceId && studies.length === 0) pricingTier = 'Better'
  else if (includeShadowFencing && studies.length > 0 && quote.best.reachOk) pricingTier = 'Best'


  // Deadhead this booking imposes on each truck's NEXT job. Recorded with the
  // reservation and returned to the caller so it is visible at the moment the
  // hold is placed — not billed, and not re-rating the successor's own quote.
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

  if (successorImpact.length > 0) {
    console.info('[client/hold-requests] downstream deadhead (not billed):', JSON.stringify(successorImpact))
  }

  const featuresJson = JSON.stringify({
    dailyRate: quote.dailyRate,
    hourSurcharge: quote.hourSurcharge,
    truckDays: quote.input.truckDays,
    truckCount: truck_count,
    activationDays,
    calendarDays,
    daysPerWeek,
    operatingHours,
    baseMedia: quote.good.baseMedia,
    shadowFencing: includeShadowFencing ? quote.better.shadowFencing : 0,
    shadowFencingFloored: quote.better.shadowFencingFloored,
    smartDirectionalIncluded: includeSmartDirectional,
    smartDirectional: includeSmartDirectional ? quote.better.smartDirectional : 0,
    deviceIdIncluded: includeDeviceId,
    deviceId: includeDeviceId ? quote.better.deviceId : 0,
    studies,
    studyCost: quote.best.studyCost,
    studiesTotal: quote.best.reachOk ? studies.length * quote.best.studyCost : 0,
    transportCharge,
    successorImpact,
  })

  // ── Create holds ────────────────────────────────────────────────────────
  const campaignGroupId = `cg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const resolvedState = state || market.split(',')[1]?.trim() || null

  // All or nothing (lib/holdRequestService.ts createClientHolds): every
  // truck's checks, then one write under the trucks' locks. A truck booked by
  // someone else since it was picked books none of them: the booking is one
  // quote, priced for every truck in it. Every truck's refusal is client-safe.
  let created: string[]
  try {
    created = await createClientHolds(session, selectedTrucks.map(truck => ({
      // Already vetted by selectTrucksForHold above — re-checking would reload
      // the fleet timelines once per truck.
      skipFeasibilityCheck: true,
      truck_number: truck.truckNumber,
      market,
      state: resolvedState,
      start_date,
      end_date,
      notes: [brand ? `Brand: ${brand}` : null, notes || null].filter(Boolean).join(' | ') || null,
      pricing_tier: pricingTier,
      quoted_total: serverTotal,
      daily_rate: quote.dailyRate,
      features: featuresJson,
      truck_count: selectedTrucks.length,
      campaign_group_id: campaignGroupId,
    })))
  } catch (err) {
    if (err instanceof ClientHoldRefusal || err instanceof HoldClashError || err instanceof HoldLockTimeoutError) {
      return reply({ error: `${err.message} Nothing was booked. Get a fresh quote and try again.` }, { status: 409 })
    }
    console.error('[client/hold-requests] failed to create holds:', err)
    return reply({ error: 'Failed to create holds' }, { status: 500 })
  }

  // ONE email for the booking, naming every truck it holds.
  await sendHoldRequestEmail({
    companyName:  session.companyName,
    truckNumbers: created,
    market,
    startDate:    start_date,
    endDate:      end_date,
    notes:        [brand ? `Brand: ${brand}` : null, notes || null, `${pricingTier} tier at $${Math.round(serverTotal).toLocaleString('en-US')}`].filter(Boolean).join(' | '),
  }).catch((e) => console.error('[client/hold-requests] email failed:', e))

  // Create Salesforce Opportunity if the client has an SFDC Account ID
  if (sfdcAccountId && isSfdcConfigured() && created.length > 0) {
    try {
      const oppName = opportunityName(brand, session.companyName, `${market} - ${start_date} to ${end_date}`)
      const firstHold = await prisma.hold.findFirst({
        where: { campaign_group_id: campaignGroupId },
        select: { expires_at: true },
      })

      const parsedFeatures = parseQuoteFeatures(featuresJson)
      const activationNotes = parsedFeatures
        ? buildActivationNotes(parsedFeatures, pricingTier)
        : undefined

      // A client's own request has no internal rep: the account's owner owns it.
      const result = await createOpportunity({
        accountId: sfdcAccountId,
        ownerId: accountInfo?.ownerId ?? undefined,
        clientType: accountInfo?.clientType,
        name: oppName,
        brand: brand || undefined,
        stageName: DEFAULT_STAGE, // a client's own request: no seller to choose
        closeDate: start_date,
        amount: serverTotal,
        market,
        holdStart: start_date,
        holdStop: end_date,
        holdExp: firstHold?.expires_at ? holdExpDate(firstHold.expires_at) : undefined,
        truckNumbers: created,
        activationNotes,
      })

      if (result.success && result.id) {
        await prisma.hold.updateMany({
          where: { campaign_group_id: campaignGroupId },
          data: { sfdc_opportunity_id: result.id },
        })
      } else {
        console.error('[client/hold-requests] SFDC opportunity creation failed:', result.errors)
      }
    } catch (err) {
      console.error('[client/hold-requests] SFDC opportunity creation error:', err)
    }
  }

  // Transport and deal-value metrics, as for staff bookings (best-effort; never
  // fails the booking). After the opportunity, so its id is on the record.
  await recordBooking({ event: 'BOOKED', groups: [{ groupId: campaignGroupId, legs: legsFromSelectedTrucks(selectedTrucks, transport) }], appQuotedTotal: serverTotal, createdBy: null })

  return reply({
    ok: true,
    created: created.length,
    failed: 0, // all or nothing: a booking that returns here held every truck
    campaignGroupId,
    trucksRequested: truck_count,
    trucksAvailable: availability.counts.total,
    message: `Reserved ${created.length} truck${created.length > 1 ? 's' : ''}. Holds expire in 72 hours.`,
    // NO _internal BLOCK HERE — client-authenticated route. successorImpact is
    // recorded on the hold's features JSON and logged; it is not sent back.
  })
}

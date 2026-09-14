import { prisma } from '@/lib/prisma'
import { canonicalMarketName } from '@/lib/marketBounds'
import { checkTruckFeasibility } from '@/lib/availabilityEngine'
import { daysUntil, MIN_CLIENT_LEAD_DAYS } from '@/lib/pricing'
import { activeHoldWhere } from '@/lib/holdFilters'
import { sendHoldRequestEmail } from '@/lib/email'
import { appendHoldRequestToSheet } from '@/lib/googleSheets'
import type { ClientSession } from '@/lib/clientAuth'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'

// Standard review SLA — 72 hours (3 days) from submission.
// Exported so the Salesforce webhook can fall back to the same window when an
// Opportunity arrives with trucks/start/stop but no Hold Exp date.
export const HOLD_EXPIRATION_HOURS = 72
// The team needs this many full days of runway before a campaign starts to actually process an
// approved hold (route the truck, confirm logistics, etc.) — the same 3-day figure as the
// standard SLA above, but anchored to the campaign's start date instead of the submission time.
const MIN_PROCESSING_DAYS_BEFORE_START = 3

/**
 * A hold's expiration is the EARLIER of the standard 72h review SLA and the latest moment that
 * still leaves MIN_PROCESSING_DAYS_BEFORE_START full days before the campaign starts.
 *
 * Exported so the staff-side "approve extension" action can grant an extension using the exact
 * same rule — a fresh 72h SLA from the moment of approval, still capped by the campaign start.
 */
export function computeHoldExpiresAt(startDate: string): Date {
  const now = new Date()

  const standardExpiry = new Date(now)
  standardExpiry.setHours(standardExpiry.getHours() + HOLD_EXPIRATION_HOURS)

  const latestByStart = new Date(startDate + 'T00:00:00Z')
  latestByStart.setUTCDate(latestByStart.getUTCDate() - MIN_PROCESSING_DAYS_BEFORE_START)
  const cappedByStart = latestByStart < now ? now : latestByStart

  return standardExpiry < cappedByStart ? standardExpiry : cappedByStart
}

export interface CreateClientHoldParams {
  truck_number: string
  market?:      string | null
  state?:       string | null
  start_date:   string // yyyy-MM-dd
  end_date:     string // yyyy-MM-dd
  notes?:       string | null
  // Pricing snapshot — from the quote engine, locked at hold creation
  pricing_tier?:      string | null
  quoted_total?:      number | null
  daily_rate?:        number | null
  features?:          string | null
  truck_count?:       number | null
  campaign_group_id?: string | null
  /**
   * Skip the feasibility check. Only for callers that already vetted this truck
   * through selectTrucksForHold — it avoids reloading the fleet timelines once
   * per truck in a multi-truck campaign. Never set it on a path where a client
   * supplies the truck number directly.
   */
  skipFeasibilityCheck?: boolean
}

/**
 * Creates a Hold record for a client-originated booking. All holds are immediately valid
 * with a 72-hour expiration window. Used by the client view auto-select flow, the legacy
 * drag-on-grid flow, and the client AI assistant.
 */
export async function createClientHold(
  session: ClientSession,
  params: CreateClientHoldParams
) {
  const {
    truck_number, market, state, start_date, end_date, notes,
    pricing_tier, quoted_total, daily_rate, features,
    truck_count, campaign_group_id,
  } = params

  // Client self-serve lead time. Enforced HERE rather than in the route because
  // both client paths funnel through this function — the auto-select flow checks
  // it earlier for a friendlier response, but the legacy drag-on-grid flow calls
  // straight in with a truck number and would otherwise skip the gate entirely.
  const leadDays = daysUntil(start_date)
  if (leadDays < MIN_CLIENT_LEAD_DAYS) {
    throw new Error(
      leadDays < 0
        ? 'That start date has already passed.'
        : `Campaigns starting within ${MIN_CLIENT_LEAD_DAYS} days can't be booked online. Submit a request and the Lime Media team will follow up.`,
    )
  }

  const expiresAt = computeHoldExpiresAt(start_date)

  // Hold.created_by is a FK to app_users — use the SFDC service user since
  // client users don't exist in that table.
  const serviceUser = await prisma.user.findFirst({
    where: { email: SFDC_SERVICE_USER_EMAIL },
    select: { id: true },
  })
  if (!serviceUser) {
    throw new Error('SFDC service user not found — cannot create client hold')
  }

  // Conflict check — prevent double-booking
  const conflicts = await prisma.hold.findMany({
    where: {
      truck_number,
      ...activeHoldWhere({ excludeAttSoft: true }),
      start_date: { lte: new Date(end_date) },
      end_date: { gte: new Date(start_date) },
    },
  })
  if (conflicts.length > 0) {
    const c = conflicts[0]
    throw new Error(`Truck ${truck_number} already booked for "${c.client_name}" from ${c.start_date.toISOString().split('T')[0]} to ${c.end_date.toISOString().split('T')[0]}`)
  }

  // The conflict query above sees the hold table ONLY — it knows nothing about
  // dbo.program_schedule, so on its own it would let a client book a truck that
  // is already out on a scheduled LED program. Same gap that was open on the
  // chat route. Callers that already vetted the truck through
  // selectTrucksForHold pass skipFeasibilityCheck to avoid reloading the fleet
  // timelines once per truck in a multi-truck campaign.
  if (!params.skipFeasibilityCheck) {
    // A lookup FAILURE is tolerated (fail-open, same as every other path); a
    // truck REJECTION must propagate. Kept separate so the throw below can
    // never be swallowed by the catch meant for infrastructure errors.
    let feasibility: Awaited<ReturnType<typeof checkTruckFeasibility>> | null = null
    try {
      feasibility = await checkTruckFeasibility({
        truckNumber: truck_number,
        market: market ?? '',
        startDate: start_date,
        endDate: end_date,
      })
    } catch (err) {
      console.error('[holdRequestService] FEASIBILITY_CHECK_FAILED (allowing hold):', err)
    }
    if (feasibility && !feasibility.ok && !feasibility.overridable) {
      throw new Error(feasibility.detail ?? `Truck ${truck_number} cannot serve these dates`)
    }
  }

  // Canonical market name — holds carry no standard_market_uid, so this string
  // is what resolves the hold's coordinates later.
  const canonicalMarket = (await canonicalMarketName(market ?? '', state ?? undefined)) ?? (market ?? '')

  const hold = await prisma.hold.create({
    data: {
      truck_number,
      client_name:       session.companyName,
      market:            canonicalMarket,
      state:             state ?? '',
      start_date:        new Date(start_date),
      end_date:          new Date(end_date),
      status:            'HOLD',
      source:            'CLIENT',
      origination:       'client-view',
      notes:             notes ?? null,
      created_by:        serviceUser.id,
      client_user_id:    session.id,
      pricing_tier:      pricing_tier ?? null,
      quoted_total:      quoted_total ?? null,
      daily_rate:        daily_rate ?? null,
      features:          features ?? null,
      truck_count:       truck_count ?? null,
      campaign_group_id: campaign_group_id ?? null,
      expires_at:        expiresAt,
    },
  })

  // Append to Google Sheet — Firefly only (no-op if env vars not set)
  if (session.companyName === 'Firefly' && session.username === 'firefly') {
    appendHoldRequestToSheet({
      submittedAt: new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }),
      companyName: session.companyName,
      truckNumber: truck_number,
      market:      market ?? '',
      state:       state  ?? '',
      startDate:   start_date,
      endDate:     end_date,
      notes:       notes  ?? '',
      status:      'HOLD',
    }).catch((e) => console.error('[sheets] append failed:', e))
  }

  // Build pricing summary for the email notification
  const pricingNote = pricing_tier && quoted_total
    ? ` | ${pricing_tier} tier at $${Math.round(quoted_total).toLocaleString('en-US')}`
    : ''

  // Send email notification (no-op if SMTP not configured)
  await sendHoldRequestEmail({
    companyName: session.companyName,
    truckNumber: truck_number,
    market:      market ?? '',
    startDate:   start_date,
    endDate:     end_date,
    notes:       (notes ?? '') + pricingNote,
  }).catch((e) => console.error('[email] send failed:', e))

  return hold
}

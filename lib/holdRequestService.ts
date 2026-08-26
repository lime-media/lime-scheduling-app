import { prisma } from '@/lib/prisma'
import { sendHoldRequestEmail } from '@/lib/email'
import { appendHoldRequestToSheet } from '@/lib/googleSheets'
import type { ClientSession } from '@/lib/clientAuth'

// Standard review SLA — 72 hours (3 days) from submission.
const HOLD_EXPIRATION_HOURS = 72
// The team needs this many full days of runway before a campaign starts to actually process an
// approved hold (route the truck, confirm logistics, etc.) — the same 3-day figure as the
// standard SLA above, but anchored to the campaign's start date instead of the submission time.
const MIN_PROCESSING_DAYS_BEFORE_START = 3

/**
 * A hold's expiration is the EARLIER of the standard 72h review SLA and the latest moment that
 * still leaves MIN_PROCESSING_DAYS_BEFORE_START full days before the campaign starts. A flat
 * 72-hour countdown makes no sense for a campaign starting in a day or two — there isn't enough
 * runway left before the trucks need to move, so the hold is already due, not "72 hours away."
 * If that start-date deadline has already passed by the time the hold is created, the hold is
 * due immediately (now), never backdated into the past.
 *
 * Exported so the staff-side "approve extension" action (app/api/hold-requests/[id]/route.ts)
 * can grant an extension using the exact same rule — a fresh 72h SLA from the moment of
 * approval, still capped by the campaign's start date.
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

export interface CreateHoldRequestParams {
  truck_number: string
  market?:      string | null
  state?:       string | null
  start_date:   string // yyyy-MM-dd
  end_date:     string // yyyy-MM-dd
  notes?:       string | null
  // Pricing snapshot — from the quote engine, locked at hold creation
  pricing_tier?:      string | null   // Good | Better | Best
  quoted_total?:      number | null   // total at the selected tier (campaign-level)
  daily_rate?:        number | null   // per-truck per-day rate
  features?:          string | null   // JSON string of included features
  truck_count?:       number | null   // total trucks in the campaign group
  campaign_group_id?: string | null   // links multi-truck holds into one campaign
}

/**
 * Single source of truth for creating a client's HoldRequest — always PENDING, always tagged
 * with the client's own client_user_id, never auto-approved. Used by both the manual
 * drag-on-the-grid submission (app/api/client/hold-requests/route.ts) and the AI assistant's
 * action-block execution (app/api/client/chat/route.ts), so the side effects (Firefly sheet
 * export, email notification) can't drift between the two entry points.
 */
export async function createHoldRequestForClient(
  session: ClientSession,
  params: CreateHoldRequestParams
) {
  const {
    truck_number, market, state, start_date, end_date, notes,
    pricing_tier, quoted_total, daily_rate, features,
    truck_count, campaign_group_id,
  } = params

  const expiresAt = computeHoldExpiresAt(start_date)

  const holdRequest = await prisma.holdRequest.create({
    data: {
      client_user_id:    session.id,
      truck_number,
      market:            market ?? '',
      state:             state  ?? null,
      start_date:        new Date(start_date),
      end_date:          new Date(end_date),
      notes:             notes  ?? null,
      status:            'PENDING',
      pricing_tier:      pricing_tier ?? null,
      quoted_total:      quoted_total ?? null,
      daily_rate:        daily_rate   ?? null,
      features:          features     ?? null,
      truck_count:       truck_count  ?? null,
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
      status:      'PENDING',
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

  return holdRequest
}

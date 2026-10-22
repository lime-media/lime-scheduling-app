import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'
import { computeHoldExpiresAt } from '@/lib/holdExpiry'
import { canonicalMarketName } from '@/lib/marketBounds'
import { checkTruckFeasibility } from '@/lib/availabilityEngine'
import { daysUntil, MIN_CLIENT_LEAD_DAYS } from '@/lib/pricing'
import { activeHoldWhere } from '@/lib/holdFilters'
import { clientBookingRefusal } from '@/lib/bookingRefusals'
import { sendHoldRequestEmail } from '@/lib/email'
import { appendHoldRequestToSheet } from '@/lib/googleSheets'
import type { ClientSession } from '@/lib/clientAuth'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'
import { writeHoldsExclusive } from '@/lib/holdWriteLock'

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
  /** Where the request came from: the client portal (default) or MCP. Shown as "Via MCP" on the schedule. */
  origination?: 'client-view' | 'mcp'
}

/**
 * A client hold refused by its checks (lead time, a hold on the truck,
 * feasibility). The message is safe to show the client: it never names who
 * holds the truck (lib/bookingRefusals.ts). Nothing was written.
 */
export class ClientHoldRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClientHoldRefusal'
  }
}

/** The service user client holds are created by (Hold.created_by is a FK to app_users; clients aren't in it). */
async function clientHoldCreator(): Promise<string> {
  const serviceUser = await prisma.user.findFirst({
    where: { email: SFDC_SERVICE_USER_EMAIL },
    select: { id: true },
  })
  if (!serviceUser) {
    throw new Error('SFDC service user not found — cannot create client hold')
  }
  return serviceUser.id
}

/**
 * The checks a client hold must pass (lead time, an existing hold on the
 * truck, feasibility) and the row it would write. Throws the refusal
 * (ClientHoldRefusal). Nothing
 * is written: the caller writes under the truck's lock (lib/holdWriteLock.ts).
 */
async function clientHoldRow(session: ClientSession, params: CreateClientHoldParams, serviceUserId: string) {
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
    throw new ClientHoldRefusal(
      leadDays < 0
        ? 'That start date has already passed.'
        : `Campaigns starting within ${MIN_CLIENT_LEAD_DAYS} days can't be booked online. Submit a request and the Lime Media team will follow up.`,
    )
  }

  const expiresAt = computeHoldExpiresAt(start_date)

  // Conflict check — prevent double-booking. AT&T soft holds count: a client
  // can never book over AT&T (only staff can release one, for a booking). The
  // message never names who holds the truck.
  const conflicts = await prisma.hold.findMany({
    where: {
      truck_number,
      ...activeHoldWhere(),
      start_date: { lte: new Date(end_date) },
      end_date: { gte: new Date(start_date) },
    },
  })
  const conflictRefusal = clientBookingRefusal(truck_number, conflicts.length, null)
  if (conflictRefusal) throw new ClientHoldRefusal(conflictRefusal)

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
    // Refused even when only an AT&T soft hold would be stranded (overridable):
    // clients never displace AT&T.
    const refusal = clientBookingRefusal(truck_number, 0, feasibility)
    if (refusal) throw new ClientHoldRefusal(refusal)
  }

  // Canonical market name — holds carry no standard_market_uid, so this string
  // is what resolves the hold's coordinates later.
  const canonicalMarket = (await canonicalMarketName(market ?? '', state ?? undefined)) ?? (market ?? '')

  return {
    truck_number,
    client_name:       session.companyName,
    market:            canonicalMarket,
    state:             state ?? '',
    start_date:        new Date(start_date),
    end_date:          new Date(end_date),
    status:            'HOLD',
    source:            'CLIENT',
    origination:       params.origination ?? 'client-view',
    notes:             notes ?? null,
    created_by:        serviceUserId,
    client_user_id:    session.id,
    pricing_tier:      pricing_tier ?? null,
    quoted_total:      quoted_total ?? null,
    daily_rate:        daily_rate ?? null,
    features:          features ?? null,
    truck_count:       truck_count ?? null,
    campaign_group_id: campaign_group_id ?? null,
    expires_at:        expiresAt,
  } satisfies Prisma.HoldCreateManyInput
}

/**
 * Creates a Hold record for a client-originated booking. All holds are immediately valid
 * with a 72-hour expiration window. Used by the legacy drag-on-grid flow; a
 * booking of trucks the engine picks (lib/clientBooking.ts) uses
 * createClientHolds (all or nothing).
 */
export async function createClientHold(
  session: ClientSession,
  params: CreateClientHoldParams
) {
  const { truck_number, start_date, end_date } = params
  const row = await clientHoldRow(session, params, await clientHoldCreator())
  // Written under the truck's lock, re-checked for a hold placed since the
  // checks (lib/holdWriteLock.ts). A clash throws, like the refusals.
  const hold = await writeHoldsExclusive([{ truck: truck_number, start: start_date.slice(0, 10), end: end_date.slice(0, 10) }], tx => tx.hold.create({ data: row }))
  afterClientHolds(session, [params])
  return notifyClientHold(session, params, hold)
}

/**
 * A client booking of trucks the engine picked (lib/clientBooking.ts): every
 * truck's checks, then every row in one write under the trucks' locks. All or
 * nothing: a refusal or a clash on any truck books none of them, so a booking
 * is never left with fewer trucks than it was picked with. Throws the refusal
 * (ClientHoldRefusal, or HoldClashError for a truck taken since it was
 * picked). Returns the truck
 * numbers held. The caller sends the one email for the booking.
 */
export async function createClientHolds(session: ClientSession, all: CreateClientHoldParams[]): Promise<string[]> {
  const serviceUserId = await clientHoldCreator()
  const rows = await Promise.all(all.map(p => clientHoldRow(session, p, serviceUserId)))
  await writeHoldsExclusive(
    all.map(p => ({ truck: p.truck_number, start: p.start_date.slice(0, 10), end: p.end_date.slice(0, 10) })),
    tx => tx.hold.createMany({ data: rows }),
  )
  afterClientHolds(session, all)
  return all.map(p => p.truck_number)
}

/** After client holds are written: Firefly's sheet. */
function afterClientHolds(session: ClientSession, all: CreateClientHoldParams[]) {
  if (!(session.companyName === 'Firefly' && session.username === 'firefly')) return
  for (const p of all) {
    appendHoldRequestToSheet({
      submittedAt: new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }),
      companyName: session.companyName,
      truckNumber: p.truck_number,
      market:      p.market ?? '',
      state:       p.state  ?? '',
      startDate:   p.start_date,
      endDate:     p.end_date,
      notes:       p.notes  ?? '',
      status:      'HOLD',
    }).catch((e) => console.error('[sheets] append failed:', e))
  }
}

/** The team's email for a single client hold (a batch's caller sends one for the booking). */
async function notifyClientHold<H>(session: ClientSession, params: CreateClientHoldParams, hold: H): Promise<H> {
  const { truck_number, market, start_date, end_date, notes, pricing_tier, quoted_total } = params
  // Build pricing summary for the email notification
  const pricingNote = pricing_tier && quoted_total
    ? ` | ${pricing_tier} tier at $${Math.round(quoted_total).toLocaleString('en-US')}`
    : ''

  // Send email notification (no-op if SMTP not configured)
  await sendHoldRequestEmail({
    companyName:  session.companyName,
    truckNumbers: [truck_number],
    market:      market ?? '',
    startDate:   start_date,
    endDate:     end_date,
    notes:       (notes ?? '') + pricingNote,
  }).catch((e) => console.error('[email] send failed:', e))

  return hold
}

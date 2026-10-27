import { NextResponse } from 'next/server'
import { ATT_RELEASE_ORIGINATION } from '@/lib/attSoftRules'
import { QUOTE_ONLY_LIST_DAYS, QUOTE_ONLY_ORIGINATION } from '@/lib/quoteOnly'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { reservationOwners } from '@/lib/reservationOwners'
import { stillListed } from '@/lib/bookings'
import { centralDate } from '@/lib/dateOnly'
import { daysSold, ledShiftsForHolds, ledStandings, type JobHold, type LedStanding } from '@/lib/ledJobs'

// EXPIRED holds accumulate forever — every lapsed hold and every Closed Lost
// Opportunity lands here and never leaves. Ops only care about the recent tail,
// so the list carries a rolling window; everything still-active is unaffected.
const EXPIRED_WINDOW_DAYS = 7

/**
 * GET /api/hold-requests
 *
 * Staff-facing unified list of ALL holds — Salesforce, Internal, Client, ATT.
 * Backs the Reservations page at app/hold-requests/page.tsx.
 *
 * EXPIRED holds are limited to the last EXPIRED_WINDOW_DAYS days, keyed on
 * `updated_at` — the moment the row was flipped to EXPIRED, which is what "when
 * did this drop off" means to ops. `expires_at` would be wrong here: it can be
 * null, and for a Closed Lost Opportunity the release has nothing to do with it.
 */
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const expiredCutoff = new Date(Date.now() - EXPIRED_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const holds = await prisma.hold.findMany({
    where: {
      OR: [
        { status: { not: 'EXPIRED' } },
        { status: 'EXPIRED', updated_at: { gte: expiredCutoff } },
        // Quote-only logs stay listed for QUOTE_ONLY_LIST_DAYS from creation
        // (their updated_at never moves, so the expired window would drop them).
        { origination: QUOTE_ONLY_ORIGINATION, created_at: { gte: new Date(Date.now() - QUOTE_ONLY_LIST_DAYS * 864e5) } },
      ],
      // AT&T soft-hold release records are not reservations (lib/attSoftRelease.ts).
      NOT: { origination: ATT_RELEASE_ORIGINATION },
    },
    orderBy:  { created_at: 'desc' },
    include:  {
      client_user: { select: { company_name: true } },
      user: { select: { name: true } },
    },
  })

  // How each committed hold stands in LED (lib/ledJobs.ts): the days its job
  // runs on its truck, of the days sold. The page stops listing a booking once
  // all of it is scheduled. If the LED database can't be read, none count as
  // scheduled, so a booking is listed rather than hidden. Independent of the
  // owner lookup, so the two run together.
  const committed: JobHold[] = holds
    .filter(h => h.status === 'COMMITTED' && h.sfdc_job_number)
    .map(h => {
      const start = h.start_date.toISOString().slice(0, 10)
      const end = h.end_date.toISOString().slice(0, 10)
      return { id: h.id, truck_number: h.truck_number, start_date: start, end_date: end, job_number: h.sfdc_job_number, days_sold: daysSold(h.features, start, end) }
    })
  // Who owns each booking (the opportunity owner, else the creator), for the Owner filter.
  // `ledUnavailable` tells the page the LED read failed, so a badge says so
  // instead of "No job number yet" on every won booking.
  let ledUnavailable = false
  const [owners, inLed] = await Promise.all([
    reservationOwners(holds.map(h => ({ id: h.id, created_by: h.created_by, created_by_name: h.user?.name ?? null, sfdc_opportunity_id: h.sfdc_opportunity_id }))),
    ledShiftsForHolds(committed)
      .then(shifts => ledStandings(committed, shifts))
      .catch((err) => {
        console.error('[hold-requests] LED schedule match failed:', err)
        ledUnavailable = true
        return new Map<string, LedStanding>()
      }),
  ])
  const rows = holds.map((h) => ({
    id:                h.id,
    truck_number:      h.truck_number,
    market:            h.market,
    state:             h.state ?? '',
    start_date:        h.start_date.toISOString().split('T')[0],
    end_date:          h.end_date.toISOString().split('T')[0],
    notes:             h.notes ?? '',
    status:            h.status,
    source:            h.source,
    origination:       h.origination,
    company_name:      h.client_user?.company_name ?? h.client_name,
    created_by_name:   h.user?.name ?? null,
    owner_id:          owners.get(h.id)!.owner_id,
    owner_name:        owners.get(h.id)!.owner_name,
    pricing_tier:      h.pricing_tier ?? null,
    quoted_total:      h.quoted_total ?? null,
    daily_rate:        h.daily_rate ?? null,
    features:          h.features ?? null,
    truck_count:       h.truck_count ?? null,
    campaign_group_id: h.campaign_group_id ?? null,
    sfdc_opportunity_id: h.sfdc_opportunity_id ?? null,
    job_number:        h.sfdc_job_number ?? null,
    led_scheduled:     inLed.get(h.id)?.scheduled ?? false,
    led_days:          inLed.get(h.id)?.days ?? 0,
    led_days_sold:     inLed.get(h.id)?.of ?? null,
    expires_at:        h.expires_at?.toISOString() ?? null,
    extension_reason:  h.extension_reason ?? null,
    extension_until:   h.extension_until?.toISOString() ?? null,
    created_at:        h.created_at.toISOString(),
  }))

  // Nothing retires a committed hold, so a won booking drops off a while after
  // it ends (lib/bookings.ts stillListed).
  return NextResponse.json({
    expired_window_days: EXPIRED_WINDOW_DAYS,
    led_unavailable: ledUnavailable,
    holdRequests: stillListed(rows, centralDate(new Date())),
  })
}

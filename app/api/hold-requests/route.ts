import { NextResponse } from 'next/server'
import { ATT_RELEASE_ORIGINATION } from '@/lib/attSoftRules'
import { QUOTE_ONLY_LIST_DAYS, QUOTE_ONLY_ORIGINATION } from '@/lib/quoteOnly'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { reservationOwners } from '@/lib/reservationOwners'
import { ledClientNames } from '@/lib/ledClients'
import { stillListed } from '@/lib/bookings'
import { centralDate } from '@/lib/dateOnly'
import { FOLLOW_SYNC_OVERDUE_MS } from '@/lib/ledTruckFollow'
import { daysSold, ledShiftsForHolds, ledStandings, type JobHold, type LedStanding } from '@/lib/ledJobs'

// EXPIRED holds accumulate forever — every lapsed hold and every Closed Lost
// Opportunity lands here and never leaves. Ops only care about the recent tail,
// so the list carries a rolling window; everything still-active is unaffected.
const EXPIRED_WINDOW_DAYS = 7

// How long a won hold's card says its truck moved to follow LED.
const LED_FOLLOW_SHOWN_DAYS = 7

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

  const fetched = await prisma.hold.findMany({
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

  // A won booking that ended more than WON_ENDED_LISTED_DAYS.notInLed ago is
  // retired whatever LED says (lib/bookings.ts stillListed), so it's dropped
  // before the owner and LED lookups: nothing retires a committed hold, and
  // that work would otherwise grow with every deal won. With no LED standing
  // yet, stillListed applies exactly that longer cutoff; the shorter one for
  // bookings LED has scheduled runs on the response below.
  const today = centralDate(new Date())
  const current = new Set(stillListed(fetched.map(h => ({
    id: h.id, campaign_group_id: h.campaign_group_id, sfdc_opportunity_id: h.sfdc_opportunity_id,
    status: h.status, end_date: h.end_date.toISOString().slice(0, 10),
  })), today).map(r => r.id))
  const holds = fetched.filter(h => current.has(h.id))

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
  // Each won booking's LED client, from its account's link (lib/ledClients.ts):
  // the client's name when LED can be read, else just that it's linked.
  const wonAccounts = [...new Set(holds.flatMap(h => h.status === 'COMMITTED' && h.sfdc_account_id ? [h.sfdc_account_id] : []))]
  // Won holds the sweep moved onto LED's truck in the last week (lib/ledTruckFollow.ts),
  // so the card says the truck changed: from the audit rows the move wrote.
  const anyWon = holds.some(h => h.status === 'COMMITTED')
  const [owners, inLed, linked, followed] = await Promise.all([
    reservationOwners(holds.map(h => ({ id: h.id, created_by: h.created_by, created_by_name: h.user?.name ?? null, sfdc_opportunity_id: h.sfdc_opportunity_id }))),
    ledShiftsForHolds(committed)
      .then(shifts => ledStandings(committed, shifts))
      .catch((err) => {
        console.error('[hold-requests] LED schedule match failed:', err)
        ledUnavailable = true
        return new Map<string, LedStanding>()
      }),
    // LED is read only for the linked clients, to name them.
    (wonAccounts.length ? prisma.ledClientLink.findMany({ where: { sfdc_account_id: { in: wonAccounts } } }) : Promise.resolve([]))
      .then(async (found) => {
        const linkOf = new Map(found.map(l => [l.sfdc_account_id, l.client_uid.toLowerCase()]))
        const clientNames = await ledClientNames([...new Set(linkOf.values())])
          .catch((err): Map<string, string> | null => { console.error('[hold-requests] LED client read failed:', err); return null })
        return { linkOf, clientNames }
      }),
    anyWon
      ? prisma.auditLog.findMany({
          // Not by hold id: won holds are never retired, and one parameter each
          // would pass SQL Server's limit. The week's swaps are few.
          where:   { action: 'SWAP_HOLD_TRUCK', created_at: { gte: new Date(Date.now() - LED_FOLLOW_SHOWN_DAYS * 864e5) } },
          select:  { hold_id: true, details: true, created_at: true },
          orderBy: { created_at: 'asc' },
        }).catch((err) => { console.error('[hold-requests] LED follow read failed:', err); return [] })
      : [],
  ])
  const { linkOf, clientNames } = linked
  const ledClientOf = (accountId: string | null) => {
    const uid = accountId ? linkOf.get(accountId) : undefined
    if (!uid) return null
    // A link to a client since deleted in LED counts as unlinked.
    if (clientNames && !clientNames.has(uid)) return null
    return { client_uid: uid, client: clientNames?.get(uid) ?? null }
  }
  // A won hold's truck changes this week, in order; the card says "moved to
  // match LED" only while its last change was a follow onto the truck it's on
  // now (a staff swap since, or a follow back, says nothing).
  const won = new Map(holds.filter(h => h.status === 'COMMITTED').map(h => [h.id, h.truck_number]))
  const lastSwap = new Map<string, { to: string; at: string; follow: boolean; first: string }>()
  for (const row of followed) {
    if (!row.hold_id || !won.has(row.hold_id)) continue
    let d: { old_truck?: string; new_truck?: string; reason?: string } = {}
    try { d = JSON.parse(row.details ?? '{}') } catch { continue }
    if (!d.old_truck || !d.new_truck) continue
    const earlier = lastSwap.get(row.hold_id)
    const follow = d.reason === 'led_truck_follow'
    // The truck it was on before this run of follows.
    const first = follow && earlier?.follow ? earlier.first : d.old_truck
    lastSwap.set(row.hold_id, { to: d.new_truck, at: row.created_at.toISOString(), follow, first })
  }
  const followedOf = new Map<string, { from: string; to: string; at: string }>()
  for (const [id, s] of lastSwap) {
    if (s.follow && s.to === won.get(id) && s.first !== s.to) followedOf.set(id, { from: s.first, to: s.to, at: s.at })
  }
  const overdueBefore = Date.now() - FOLLOW_SYNC_OVERDUE_MS
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
    sfdc_account_id:   h.sfdc_account_id ?? null,
    led_client:        ledClientOf(h.sfdc_account_id),
    led_scheduled:     inLed.get(h.id)?.scheduled ?? false,
    led_days:          inLed.get(h.id)?.days ?? 0,
    led_days_sold:     inLed.get(h.id)?.of ?? null,
    led_followed:      followedOf.get(h.id) ?? null,
    // Moved to LED's truck but Salesforce's LED Trucks still refuses it (lib/ledTruckFollow.ts).
    led_trucks_unsynced_since: h.status === 'COMMITTED' && h.sfdc_opportunity_id && h.led_follow_sync_pending && h.led_follow_sync_pending.getTime() < overdueBefore
      ? h.led_follow_sync_pending.toISOString() : null,
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
    holdRequests: stillListed(rows, today),
  })
}

/**
 * A client's multi-market quote and booking (POST /api/client/plan/quote and
 * /api/client/plan/hold): the staff multi-market engine (lib/planning/quote.ts)
 * under the client rules (lib/clientPlan.ts), priced on the client's own rate
 * card, with the Brand Direct markup the account carries. Returns the route's
 * status and JSON body.
 *
 * Pricing. Each market is priced on its own truck-days, as a single-market
 * quote would price it: there is no discount across the order. When some
 * trucks can't be covered, the quote also gives "what fits": the uncovered
 * trucks dropped and the rest routed and priced again (bookWhatFits), so a
 * market that loses trucks is priced at the rate for the trucks it keeps.
 * The booking books what fits only at the total the client was shown; any
 * other total is refused with the new one, and nothing is booked.
 *
 * A booking is one quote: one campaign group per market under one booking
 * key (`mm_<request>_N`, lib/bookings.ts), one expiry on every hold (the
 * client's 72 hours, capped by the earliest start), one Salesforce
 * opportunity, one email. All or nothing: the holds are written in one
 * transaction under the trucks' locks, re-checked there, AT&T soft holds
 * included (a client never displaces AT&T).
 *
 * Client-authenticated: nothing returned names a truck's origin, transport we
 * absorb or fleet counts (clientLine).
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { ClientSession } from '@/lib/clientAuth'
import { liveClientLinks } from '@/lib/clientLinks'
import { reply, type CoreResult } from '@/lib/coreResult'
import { cleanBrand, opportunityName } from '@/lib/brand'
import { bookingHoldExpiry, DEFAULT_HOLD_DAYS } from '@/lib/holdExpiry'
import { holdExpDate } from '@/lib/dateOnly'
import { clientRateCard } from '@/lib/pricing/resolvers'
import type { RateOverrides } from '@/lib/pricing/config'
import { getSfdcAccountInfo, isSfdcConfigured } from '@/lib/salesforceClient'
import { createAppOpportunity } from '@/lib/opportunityOrigins'
import { CLIENT_PORTAL_LEAD_SOURCE } from '@/lib/sfdcLeadSource'
import { DEFAULT_STAGE } from '@/lib/sfdcStages'
import { HoldClashError, HoldLockTimeoutError, writeHoldsExclusive } from '@/lib/holdWriteLock'
import { afterClientHolds, clientHoldCreator } from '@/lib/holdRequestService'
import { sendHoldRequestEmail } from '@/lib/email'
import { recordBooking } from '@/lib/transportMetricsRecord'
import { legsFromArrivals } from '@/lib/transportMetrics'
import { bookWhatFits, buildMultiMarketQuote, holdPlaces, resolveRows, type PreparedQuote, type QuoteRequest } from '@/lib/planning/quote'
import { describeBooked, describeQuoted, fitNames, lineFeatures, money, planStretches, planTier } from '@/lib/planning/booking'
import { clientLine, parseClientPlan, sameTrucks } from '@/lib/clientPlan'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Thrown inside the write when this booking's id already has holds (a double submit). Nothing was written. */
class AlreadyPlaced extends Error {}

type AccountInfo = Awaited<ReturnType<typeof getSfdcAccountInfo>>
type Rates = { overrides: RateOverrides | null; basis: string }

type Prepared =
  | { refused: CoreResult }
  | { refused: null; req: QuoteRequest; rates: Rates; sfdcAccountId?: string; accountInfo: AccountInfo }

/** The request by the client rules, priced on the client's rate card. */
async function prepare(session: ClientSession, input: unknown): Promise<Prepared> {
  const parsed = parseClientPlan(input)
  if ('error' in parsed) return { refused: reply({ error: parsed.error }, { status: 400 }) }
  const [card, links] = await Promise.all([clientRateCard(session), liveClientLinks(session)])
  // The account read once, for the price and the opportunity's owner: every
  // routing round prices with the same client type. Unreachable, the quote
  // engine tries again itself, as the single-market quote degrades.
  const accountInfo = links.sfdcAccountId && isSfdcConfigured()
    ? await getSfdcAccountInfo(links.sfdcAccountId).catch((err) => { console.error('[client/plan] account lookup failed:', err); return null })
    : null
  return {
    refused: null,
    // No client type or markup from the client: the account's Brand Direct
    // type and the default markup apply (buildMultiMarketQuote). AT&T's
    // soft-hold trucks are always held back.
    req: { rows: parsed.rows, features: parsed.features, sfdcAccountId: links.sfdcAccountId, reserveSoftHolds: true, ...(accountInfo ? { clientType: accountInfo.clientType } : {}) },
    rates: { overrides: card.overrides, basis: card.agreement ? 'agreement' : 'standard' },
    sfdcAccountId: links.sfdcAccountId,
    accountInfo,
  }
}

/** The order routed and priced from fresh data, and what fits when it falls short. */
async function route(p: Extract<Prepared, { refused: null }>): Promise<CoreResult | { asked: PreparedQuote; fits: PreparedQuote | null }> {
  const { lines, errors } = await resolveRows(p.req.rows)
  if (errors.length) return reply({ error: 'Some markets need attention.', rowErrors: errors }, { status: 400 })
  const asked = await buildMultiMarketQuote(p.req, lines, { alternatives: false, rates: p.rates })
  const fits = asked.plan.shortfalls.length ? await bookWhatFits(p.req, lines, asked, { rates: p.rates }) : asked
  return { asked, fits }
}

const view = (q: PreparedQuote) => ({ lines: q.quote.lines.map(clientLine), total: q.quote.summary.grandTotal })

/** POST /api/client/plan/quote */
export async function clientMultiMarketQuote(session: ClientSession, input: unknown): Promise<CoreResult> {
  const p = await prepare(session, input)
  if (p.refused) return p.refused
  const routed = await route(p)
  if ('status' in routed) return routed
  const { asked, fits } = routed
  const short = asked.plan.shortfalls.length > 0
  return reply({
    // As asked: a market's `missing` trucks are priced at the days asked, so
    // this total is what the whole order would cost, not what can be booked.
    asked: view(asked),
    short,
    // What can be booked now, at its own price. Null: none of it can.
    fits: fits ? view(fits) : null,
  })
}

export type ClientPlanHoldInput = {
  rows?: unknown
  features?: unknown
  /** One id per booking attempt; a retry with the same id returns the first result. */
  requestId?: unknown
  /** The total the client was shown for what fits; the booking stops if it differs. */
  expectedTotal?: unknown
  /** The trucks the client was shown per market (row id), for what fits; the booking stops if they differ. */
  expectedTrucks?: unknown
  brand?: unknown
  notes?: unknown
}

/** POST /api/client/plan/hold */
export async function placeClientMultiMarketBooking(session: ClientSession, input: ClientPlanHoldInput): Promise<CoreResult> {
  const body = (input && typeof input === 'object' ? input : {}) as ClientPlanHoldInput
  const requestId = body.requestId
  // No underscore: holds are found by the prefix `mm_<id>_`, so an id with
  // one could match another booking's (`abcdefgh` would find `abcdefgh_2`'s).
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(requestId)) return reply({ error: 'Missing booking request id.' }, { status: 400 })
  // The client books only at a price it was shown.
  const expectedTotal = body.expectedTotal
  if (typeof expectedTotal !== 'number' || !Number.isFinite(expectedTotal)) return reply({ error: 'Missing the total you were quoted. Get a quote first.' }, { status: 400 })
  const expectedTrucks = body.expectedTrucks
  if (!expectedTrucks || typeof expectedTrucks !== 'object' || Array.isArray(expectedTrucks)
    || !Object.values(expectedTrucks).every(n => typeof n === 'number' && Number.isInteger(n) && n > 0)) {
    return reply({ error: 'Missing the markets you were quoted. Get a quote first.' }, { status: 400 })
  }
  if (body.notes !== undefined && typeof body.notes !== 'string') return reply({ error: 'Notes must be text.' }, { status: 400 })
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 1000) : ''
  const brand = cleanBrand(typeof body.brand === 'string' ? body.brand : undefined)

  const groupPrefix = `mm_${requestId}_`
  // A retry of an attempt that went through: what it booked. Another
  // client's booking under the same id is never answered from. Null: nothing
  // booked under this id yet.
  const placedEarlier = async (): Promise<CoreResult | null> => {
    const earlier = await prisma.hold.findMany({
      where: { campaign_group_id: { startsWith: groupPrefix } },
      select: { market: true, client_user_id: true },
    })
    if (earlier.length === 0) return null
    if (earlier.some(h => h.client_user_id !== session.id)) return reply({ error: 'That booking request id is taken. Get a fresh quote and book again.' }, { status: 409 })
    const markets = [...new Set(earlier.map(h => h.market))]
    return reply({
      ok: true,
      alreadyPlaced: true,
      markets,
      message: `This booking was already placed (${plural(markets.length, 'market')}). Nothing new was booked.`,
    })
  }

  try {
    // Before the account read and the routing: a retry costs one query.
    const retried = await placedEarlier()
    if (retried) return retried

    const p = await prepare(session, body)
    if (p.refused) return p.refused
    const routed = await route(p)
    if ('status' in routed) return routed
    const { asked, fits } = routed
    // A double submit whose routing read the fleet after the first one's holds
    // were saved finds its trucks taken: answered as its retry, not as a change.
    const refuse = async (r: CoreResult) => (await placedEarlier()) ?? r
    if (!fits) return refuse(reply({ error: 'No trucks can be booked for these markets and dates right now. Submit a request and the Lime Media team will work on a solution.' }, { status: 409 }))
    const { quote, plan } = fits
    // What the client agreed to: these markets, these trucks, this total. The
    // same total can come from different markets when the fleet moves.
    if (Math.abs(quote.summary.grandTotal - expectedTotal) >= 1 || !sameTrucks(quote.lines, expectedTrucks as Record<string, number>)) {
      return refuse(reply({
        error: 'What can be booked changed since you were quoted. Nothing was booked; check the new quote.',
        priceChanged: { was: expectedTotal, now: quote.summary.grandTotal },
        short: asked.plan.shortfalls.length > 0,
        fits: view(fits),
      }, { status: 409 }))
    }

    const lineById = new Map(quote.lines.map(l => [l.id, l]))
    const place = await holdPlaces(fits)
    const stretches = planStretches(plan)
    // One expiry for the booking: the client's standard hold, capped by the earliest start.
    const expiry = bookingHoldExpiry(stretches.map(x => x.stint.start), DEFAULT_HOLD_DAYS, new Date())
    // Hold.created_by is a user; clients aren't users.
    const createdBy = await clientHoldCreator()
    const f = p.req.features
    const tier = planTier(f)
    const groupOf = new Map(quote.lines.map((l, i) => [l.id, `${groupPrefix}${i + 1}`]))
    const company = session.companyName
    const rows: Prisma.HoldCreateManyInput[] = stretches.map(({ truckNumber, stint, partner }) => {
      const lq = lineById.get(stint.lineId)!
      const where = place.get(stint.lineId)!
      return {
        truck_number: truckNumber,
        client_name: company,
        market: where.market,
        state: where.state,
        start_date: new Date(stint.start),
        end_date: new Date(stint.end),
        status: 'HOLD',
        source: 'CLIENT',
        origination: 'client-view',
        notes: `${lq.market}, part of a ${quote.summary.markets}-market order${brand ? ` (brand: ${brand})` : ''}.`
          + (partner ? ` Truck alternates weekly with ${partner}.` : '')
          + (stint.travelTo ? ` Last day is travel to ${stint.travelTo}.` : '')
          + (notes ? ` ${notes}` : ''),
        created_by: createdBy,
        client_user_id: session.id,
        pricing_tier: tier,
        quoted_total: lq.total,
        daily_rate: lq.effectiveDailyRate,
        // The line's quote, plus what this hold itself sells (lib/ledJobs.ts daysSold).
        features: JSON.stringify({ ...lineFeatures(lq, f, quote.brandMarkupPct, quote.clientType), heldStart: stint.start, heldEnd: stint.end, heldWorkDays: stint.workDays }),
        truck_count: lq.trucks,
        campaign_group_id: groupOf.get(stint.lineId)!,
        expires_at: expiry.expiresAt,
      }
    })
    try {
      // Re-checked under each truck's lock, AT&T soft holds included.
      // A double submit with this id, routed onto other trucks while the first
      // was saving, waits on the id's own lock and then finds the first's holds.
      await writeHoldsExclusive(
        stretches.map(x => ({ truck: x.truckNumber, start: x.stint.start, end: x.stint.end })),
        async tx => {
          const [lock] = await tx.$queryRaw<{ r: number }[]>`
            DECLARE @r int;
            EXEC @r = sp_getapplock @Resource = ${`hold-request:${groupPrefix}`}, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 15000;
            SELECT @r AS r;`
          // Not held: the first submit is still saving. Nothing is written; trying again answers from it.
          if (!lock || lock.r < 0) throw new HoldLockTimeoutError('of this booking')
          if (await tx.hold.count({ where: { campaign_group_id: { startsWith: groupPrefix } } }) > 0) throw new AlreadyPlaced()
          return tx.hold.createMany({ data: rows })
        },
      )
    } catch (err) {
      // A double submit of this booking: answered as its retry, not as a clash
      // with the client's own holds.
      if (err instanceof AlreadyPlaced || err instanceof HoldClashError) {
        const retried = await placedEarlier()
        if (retried) return retried
      }
      // Not err.message: it names the trucks, which a client never sees (clientLine).
      if (err instanceof HoldClashError) {
        return reply({ error: 'Some of these trucks were booked by someone else since you were quoted. Nothing was booked. Get a fresh quote and try again.' }, { status: 409 })
      }
      if (err instanceof HoldLockTimeoutError) {
        return reply({ error: 'Another booking of these trucks is being saved right now. Nothing was booked. Try again in a moment.' }, { status: 409 })
      }
      throw err
    }
    const truckNumbers = [...new Set(stretches.map(x => x.truckNumber))]
    afterClientHolds(session, stretches.map(x => ({
      truck_number: x.truckNumber, market: place.get(x.stint.lineId)!.market, state: place.get(x.stint.lineId)!.state,
      start_date: x.stint.start, end_date: x.stint.end, notes: notes || null,
    })))

    // What was asked and isn't booked: trucks that can't be covered.
    const bookedTrucks = new Map(quote.lines.map(l => [l.id, l.trucks]))
    const notBooked = asked.quote.lines
      .filter(l => (bookedTrucks.get(l.id) ?? 0) < l.trucks)
      .map(l => describeQuoted(l, l.trucks - (bookedTrucks.get(l.id) ?? 0)))
    const markets = [...new Set(quote.lines.map(l => place.get(l.id)!.market))]
    const starts = quote.lines.map(l => l.delivery.firstDay ?? l.startDate).sort()
    const ends = quote.lines.map(l => l.delivery.lastDay ?? l.endDate).sort()
    const total = quote.summary.grandTotal

    // ONE email for the booking.
    await sendHoldRequestEmail({
      companyName: company,
      truckNumbers,
      market: `${plural(markets.length, 'market')}: ${markets.join('; ')}`,
      startDate: starts[0],
      endDate: ends[ends.length - 1],
      notes: [brand ? `Brand: ${brand}` : null, notes || null, `Multi-market at ${money(total)}`, notBooked.length ? `Not booked (no truck): ${notBooked.join('; ')}` : null].filter(Boolean).join(' | '),
    }).catch(e => console.error('[client/plan/hold] email failed:', e))

    // One opportunity for the booking, owned by the account's owner (a
    // client's own request has no rep), as the single-market booking does.
    if (p.sfdcAccountId && isSfdcConfigured()) {
      try {
        const accountInfo = p.accountInfo ?? await getSfdcAccountInfo(p.sfdcAccountId).catch(() => null)
        const description = [
          ...(quote.brandMarkupPct ? [`Brand Direct pricing: +${quote.brandMarkupPct}% folded into every line item.`, ''] : []),
          'Booked by the client in the portal:',
          ...quote.lines.map(l => `${describeBooked(l)}, ${money(l.total)}`),
          ...(notBooked.length ? ['', 'Asked for but no truck available:', ...notBooked] : []),
        ].join('\n')
        const result = await createAppOpportunity({
          accountId: p.sfdcAccountId,
          ownerId: accountInfo?.ownerId ?? undefined,
          clientType: quote.clientType ?? accountInfo?.clientType,
          leadSource: CLIENT_PORTAL_LEAD_SOURCE,
          name: opportunityName(brand, company, `Multi-market (${plural(markets.length, 'market')}) - ${starts[0]} to ${ends[ends.length - 1]}`),
          brand: brand || undefined,
          stageName: DEFAULT_STAGE,
          closeDate: starts[0],
          amount: total,
          market: fitNames(markets, 255),
          holdStart: starts[0],
          holdStop: ends[ends.length - 1],
          holdExp: holdExpDate(expiry.expiresAt),
          truckNumbers,
          activationNotes: `Multi-market (client portal): ${plural(quote.lines.length, 'market')} booked, ${money(total)}.`
            + (notBooked.length ? ` ${notBooked.length} asked for but no truck available.` : '')
            + ' Breakdown in Description.',
          description,
        }, { createdBy: null, path: 'client' })
        if (result.success && result.id) {
          await prisma.hold.updateMany({ where: { campaign_group_id: { startsWith: groupPrefix } }, data: { sfdc_opportunity_id: result.id } })
        } else {
          console.error('[client/plan/hold] SFDC opportunity creation failed:', result.errors)
        }
      } catch (err) {
        console.error('[client/plan/hold] SFDC opportunity creation error:', err)
      }
    }

    // Transport and deal-value metrics (best-effort; never fails the booking).
    await recordBooking({ event: 'BOOKED', groups: quote.lines.map(l => ({ groupId: groupOf.get(l.id)!, legs: legsFromArrivals(l.arrivals) })), appQuotedTotal: total, createdBy: null })

    return reply({
      ok: true,
      markets,
      // As the usage log reads a booking (lib/usageLog.ts summarizeResult).
      grandTotal: total,
      created: rows.length,
      expiresAt: expiry.expiresAt.toISOString(),
      notBooked: notBooked.length,
      message: `Reserved ${plural(truckNumbers.length, 'truck')} across ${plural(markets.length, 'market')} (${money(total)}).`
        + (notBooked.length ? ` ${plural(notBooked.length, 'market')} couldn't be fully covered and ${notBooked.length === 1 ? 'was' : 'were'} booked short or left out, as quoted.` : ''),
    })
  } catch (err) {
    console.error('[client/plan/hold] failed:', err)
    return reply({ error: `Booking stopped before it finished. The holds are written in one transaction, so none were placed unless a retry reports them. Retrying is safe.` }, { status: 500 })
  }
}

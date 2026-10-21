/**
 * Client availability: whether a client may book this market and these dates
 * online, by the client portal's rules — the lead-time minimum, the
 * contiguous 48, the client's own rate card (its service area), and no
 * displacing an AT&T soft hold. Shared by POST /api/client/quote and the
 * client portal AI chat, so the chat never says yes to a booking the quote
 * form would refuse. A refusal is returned as the quote route's response
 * body: no truck numbers or exclusion reasons, but the "not enough trucks"
 * refusal does carry availability counts (as the quote form's success
 * response does), so the chat passes on only its message.
 */

import type { ClientSession } from '@/lib/clientAuth'
import { checkAvailability, type AvailabilityResult } from '@/lib/availabilityEngine'
import { daysUntil, MIN_CLIENT_LEAD_DAYS } from '@/lib/pricing'
import {
  resolveMarketInputAll,
  resolveMarketSizeTierId,
  resolveRateOverrides,
  resolveDefaultRateOverrides,
} from '@/lib/pricing/resolvers'

export type ClientAvailabilityRequest = { market: string; start_date: string; end_date: string; truck_count: number }

type Refusal = { status: number; body: Record<string, unknown> }

export type ClientAvailability =
  | { refused: Refusal }
  | {
      refused: null
      formalMarket: string
      calendarDays: number
      availability: AvailabilityResult
      rateOverrides: Awaited<ReturnType<typeof resolveRateOverrides>>
      marketSizeTierId: Awaited<ReturnType<typeof resolveMarketSizeTierId>>
    }

const refuse = (body: Record<string, unknown>, init?: { status: number }): ClientAvailability => ({ refused: { status: init?.status ?? 200, body } })

export async function clientAvailability(session: ClientSession, request: ClientAvailabilityRequest): Promise<ClientAvailability> {
  const { market, start_date, end_date, truck_count } = request

  // Near-term campaigns are not self-serviceable. Internal staff are NOT subject
  // to this (see /api/quote) — they may have approval or context the engine
  // lacks. This is a CLIENT-surface policy, enforced server-side so it cannot be
  // bypassed by calling the API directly.
  const leadDays = daysUntil(start_date)
  if (leadDays < MIN_CLIENT_LEAD_DAYS) {
    return refuse({
      insufficient: true,
      rushBlocked: true,
      message: leadDays < 0
        ? 'That start date has already passed. Please choose a future date.'
        : `Campaigns starting within ${MIN_CLIENT_LEAD_DAYS} days can't be booked online — there isn't enough time to position trucks and crew. Submit a request and the Lime Media team will see what's possible.`,
    })
  }

  // Resolve the market input — handles disambiguation and formalization
  // Resolve against the hardcoded map AND the 356-market list the team
  // maintains — /api/markets autocompletes from the latter, so gating on the
  // former would reject markets the rep just picked from the dropdown.
  const marketMatches = await resolveMarketInputAll(market)

  if (marketMatches.length === 0) {
    return refuse({
      error: `We couldn't find "${market}". Use a US city with its state (e.g. "Ames, IA") or a ZIP code.`,
    }, { status: 400 })
  }

  if (marketMatches.length > 1) {
    return refuse({
      error: 'DISAMBIGUATION_REQUIRED',
      message: `Multiple markets match "${market}". Please select one:`,
      candidates: marketMatches.map(m => m.formal),
    }, { status: 400 })
  }

  // Single match — use the formalized name going forward
  const resolvedMarket = marketMatches[0]
  const formalMarket = resolvedMarket.formal

  // Only serve the contiguous 48 states
  const EXCLUDED_STATES = new Set(['AK', 'HI'])
  const stateAbbr = formalMarket.split(',').pop()?.trim().toUpperCase()
  if (stateAbbr && EXCLUDED_STATES.has(stateAbbr)) {
    return refuse({
      error: `We currently only serve markets within the contiguous 48 states. ${formalMarket} is outside our service area.`,
    }, { status: 400 })
  }

  const startDate = new Date(start_date + 'T00:00:00Z')
  const endDate = new Date(end_date + 'T00:00:00Z')
  const calendarDays = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1
  if (!Number.isFinite(calendarDays) || calendarDays < 1) {
    return refuse({ error: 'Invalid date range' }, { status: 400 })
  }

  // Resolve rate overrides first — service_area_miles affects availability classification
  const [clientOverrides, defaultOverrides, marketSizeTierId] = await Promise.all([
    resolveRateOverrides(session),
    resolveDefaultRateOverrides(),
    resolveMarketSizeTierId(formalMarket),
  ])

  const rateOverrides = clientOverrides
    ? { ...defaultOverrides, ...clientOverrides, daily_rates: { ...defaultOverrides?.daily_rates, ...clientOverrides.daily_rates } }
    : defaultOverrides

  const availability = await checkAvailability({
    market: formalMarket,
    startDate: start_date,
    endDate: end_date,
    truckCount: truck_count,
    serviceAreaMiles: rateOverrides?.service_area_miles,
  })

  // There are exactly two reasons to refuse a quote: the market is outside the
  // service area, or no reachable truck exists. Truck COUNT is never one of
  // them — extra trucks come from further away and the distance is billed.
  if (!availability.marketResolved) {
    return refuse({
      availability: {
        requested: truck_count, available: 0, local: 0, nearby: 0,
        repositioning: 0, sufficient: false,
      },
      insufficient: true,
      outOfServiceArea: true,
      message: `We could not locate "${formalMarket}". Lime Media serves the contiguous 48 states — check the spelling, or submit a request and the team will follow up.`,
    })
  }

  // Not enough reachable trucks to fill the request — every truck that could
  // physically make these dates is already committed.
  if (!availability.sufficient) {
    return refuse({
      availability: {
        requested: truck_count,
        available: availability.counts.total,
        local: availability.counts.local,
        nearby: availability.counts.nearby,
        repositioning: availability.counts.repositioning,
        sufficient: false,
      },
      insufficient: true,
      // Client-facing: the headline only. Truck counts and exclusion reasons are
      // fleet posture and stay on the staff route.
      message: 'Automatic quote not feasible without changing existing reservations or commitments. Submit a request and the Lime Media team will work on a solution.',
    })
  }

  return { refused: null, formalMarket, calendarDays, availability, rateOverrides, marketSizeTierId }
}

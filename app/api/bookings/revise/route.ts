/**
 * GET /api/bookings/revise?key=<booking key> — a booking as the multi-market
 * planner opens it for revision: its account, opportunity, primary contact,
 * brand (from the opportunity, else as booked: lib/bookingParty.ts), markets (as planner rows, with the trucks a live booking keeps) and
 * options. Staff only. Refuses what cannot be revised (lib/bookings.ts
 * reviseRefusal; a lost opportunity: lib/sfdcBooking.ts opportunityRefusal).
 * A Closed Lost opportunity answers 409 `reopenable` so the planner can ask
 * whether to move it back to WARM; `&reopen=1` then loads the booking. Nothing
 * is written here: the reopen happens when the revision is saved
 * (app/api/plan/hold, reopenOpportunity).
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/planning/http'
import { loadBookingHolds } from '@/lib/bookingLoad'
import { reviseRefusal, reviseRows } from '@/lib/bookings'
import { getBookingOpportunity, opportunityRefusal } from '@/lib/sfdcBooking'
import { reactivationDecision, reopenQuestion } from '@/lib/sfdcIntegration'
import { clientTypeOf } from '@/lib/pricing/brandMarkup'
import { reviseParty } from '@/lib/bookingParty'
import { isSfdcConfigured } from '@/lib/salesforceClient'

export async function GET(req: NextRequest) {
  const denied = await requireStaff(req)
  if (denied) return denied
  const key = req.nextUrl.searchParams.get('key') ?? ''
  const holds = await loadBookingHolds(key)
  const refusal = reviseRefusal(holds)
  if (refusal) return NextResponse.json({ error: refusal }, { status: holds.length ? 409 : 404 })

  const oppId = holds.find(h => h.sfdc_opportunity_id)?.sfdc_opportunity_id ?? null
  let opp = null
  if (oppId) {
    // Saving the revision has to update this opportunity, which needs Salesforce.
    if (!isSfdcConfigured()) return NextResponse.json({ error: 'Salesforce is not configured, so this booking\'s opportunity cannot be updated.' }, { status: 503 })
    try {
      opp = await getBookingOpportunity(oppId)
    } catch (err) {
      console.error('[bookings/revise] opportunity read failed:', err)
      return NextResponse.json({ error: 'Salesforce could not be reached to load this booking\'s opportunity. Try again.' }, { status: 503 })
    }
    if (opp) {
      const decision = reactivationDecision({ isClosed: opp.IsClosed, isWon: opp.IsWon, stageName: opp.StageName }, req.nextUrl.searchParams.get('reopen') === '1')
      if (decision.kind === 'reopenable') {
        return NextResponse.json({
          error: opportunityRefusal(opp, opp.AccountId),
          reopenable: { opportunityId: opp.Id, stageName: decision.stageName, question: reopenQuestion(decision.stageName) },
        }, { status: 409 })
      }
      const lost = opportunityRefusal(opp, opp.AccountId, { closedLostReopening: decision.kind === 'reopen' })
      if (lost) return NextResponse.json({ error: lost }, { status: 409 })
    }
  }

  const { rows, features, live, quoteOnly, brandMarkupPct, clientType } = reviseRows(holds)
  const { account, contact, brand } = reviseParty({
    opp, holds, clientType,
    oppClientType: opp ? clientTypeOf(opp.Account?.Client_Type2__c ?? null) : undefined,
  })
  return NextResponse.json({
    booking: {
      key,
      opportunityId: opp?.Id ?? null,
      opportunityName: opp?.Name ?? null,
      // From the opportunity where it has them, else as the booking recorded
      // them (lib/bookingParty.ts): a booking with no opportunity (Salesforce
      // was down or writes were off) reopens with its account, contact and
      // brand. Only a booking with neither asks for the account again.
      account, contact, brand,
      clientName: holds[0].client_name,
      rows, features, live, quoteOnly, brandMarkupPct,
      // The client type it was priced as (null on older holds).
      clientType,
      // What a revision keeps (app/api/plan/hold): the latest expiry of the
      // live holds, and the markets ops marked committed.
      heldUntil: holds.filter(h => h.live && h.expires_at).map(h => h.expires_at!.toISOString()).sort().reverse()[0] ?? null,
      committedMarkets: [...new Set(holds.filter(h => h.live && h.status === 'COMMITTED').map(h => h.market.trim().toLowerCase()))],
    },
  })
}

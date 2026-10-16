/**
 * GET /api/bookings/revise?key=<booking key> — a booking as the multi-market
 * planner opens it for revision: its account, opportunity, primary contact,
 * brand, markets (as planner rows, with the trucks a live booking keeps) and
 * options. Staff only. Refuses what cannot be revised (lib/bookings.ts
 * reviseRefusal; a lost opportunity: lib/sfdcBooking.ts opportunityRefusal).
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/planning/http'
import { loadBookingHolds } from '@/lib/bookingLoad'
import { reviseRefusal, reviseRows } from '@/lib/bookings'
import { getBookingOpportunity, opportunityRefusal } from '@/lib/sfdcBooking'
import { clientTypeOf } from '@/lib/pricing/brandMarkup'

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
    try {
      opp = await getBookingOpportunity(oppId)
    } catch (err) {
      console.error('[bookings/revise] opportunity read failed:', err)
      return NextResponse.json({ error: 'Salesforce could not be reached to load this booking\'s opportunity. Try again.' }, { status: 503 })
    }
    if (opp) {
      const lost = opportunityRefusal(opp, opp.AccountId)
      if (lost) return NextResponse.json({ error: lost }, { status: 409 })
    }
  }

  const { rows, features, live, quoteOnly } = reviseRows(holds)
  return NextResponse.json({
    booking: {
      key,
      opportunityId: opp?.Id ?? null,
      opportunityName: opp?.Name ?? null,
      // Without an opportunity (Salesforce was down when it was booked), the
      // planner asks for the account again.
      account: opp ? { id: opp.AccountId, name: opp.Account?.Name ?? holds[0].client_name, clientType: clientTypeOf(opp.Account?.Client_Type2__c ?? null) } : null,
      contact: opp?.Primary_Contact__c && opp.Primary_Contact__r
        ? { id: opp.Primary_Contact__c, name: opp.Primary_Contact__r.Name, email: opp.Primary_Contact__r.Email, title: opp.Primary_Contact__r.Title }
        : null,
      brand: opp?.Brand_Job_Name__c ?? '',
      clientName: holds[0].client_name,
      rows, features, live, quoteOnly,
    },
  })
}

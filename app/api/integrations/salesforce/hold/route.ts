import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getLiveVehicleLocations } from '@/lib/samsaraService'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'

interface SfdcHoldPayload {
  opportunityId: string
  accountName:   string
  trucks:        string // multi-select picklist value, e.g. "7423;0820"
  holdStart:     string // yyyy-MM-dd
  holdStop:      string // yyyy-MM-dd
  holdExp?:      string // yyyy-MM-dd
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-sfdc-webhook-secret')
  if (!process.env.SFDC_WEBHOOK_SECRET || secret !== process.env.SFDC_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await req.json()) as Partial<SfdcHoldPayload>
  const { opportunityId, accountName, trucks, holdStart, holdStop, holdExp } = body

  if (!opportunityId || !accountName || !trucks || !holdStart || !holdStop) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const serviceUser = await prisma.user.findUnique({ where: { email: SFDC_SERVICE_USER_EMAIL } })
  if (!serviceUser) {
    return NextResponse.json({ error: `Service user ${SFDC_SERVICE_USER_EMAIL} not found — create it via the Users admin page first` }, { status: 500 })
  }

  const truckNumbers = trucks
    .split(/[;,]/)
    .map((t) => t.trim().replace(/^LED[\s-]*/i, ''))
    .filter(Boolean)

  if (truckNumbers.length === 0) {
    return NextResponse.json({ error: 'No truck numbers found in trucks field' }, { status: 400 })
  }

  const gpsMap = await getLiveVehicleLocations().catch(() => new Map())

  const start_date = new Date(holdStart)
  const end_date   = new Date(holdStop)
  const sfdc_hold_exp = holdExp ? new Date(holdExp) : null

  const results: Array<{ truck_number: string; hold_id: string; action: 'created' | 'updated' | 'removed' }> = []

  // Reconcile: drop holds this Opportunity previously pushed for trucks that
  // are no longer in its current LED Trucks list (e.g. a truck got swapped out).
  const stale = await prisma.hold.findMany({
    where: { sfdc_opportunity_id: opportunityId, truck_number: { notIn: truckNumbers } },
  })
  for (const hold of stale) {
    await prisma.auditLog.create({
      data: {
        action:       'DELETE_HOLD',
        truck_number: hold.truck_number,
        user_id:      serviceUser.id,
        hold_id:      hold.id,
        details:      JSON.stringify({ reason: 'sfdc_truck_removed_from_opportunity', opportunityId }),
      },
    })
    await prisma.hold.delete({ where: { id: hold.id } })
    results.push({ truck_number: hold.truck_number, hold_id: hold.id, action: 'removed' })
  }

  for (const truck_number of truckNumbers) {
    const gps    = gpsMap.get(truck_number)
    const market = gps ? `${gps.city}, ${gps.state}` : ''
    const state  = gps?.state ?? ''

    const existing = await prisma.hold.findFirst({
      where: { sfdc_opportunity_id: opportunityId, truck_number },
    })

    if (existing) {
      // A hold auto-expired by lib/scheduleCache.ts's expireSfdcHolds() means the deal
      // was stale as of its old sfdc_hold_exp — a fresh push means Salesforce still
      // considers it active, so un-expire it. A COMMITTED hold is left alone; that's a
      // real booking, not something this webhook should revert.
      const reactivated = existing.status === 'EXPIRED'
      const updated = await prisma.hold.update({
        where: { id: existing.id },
        data: {
          market, state, client_name: accountName, start_date, end_date, sfdc_hold_exp,
          expires_at: sfdc_hold_exp,
          ...(reactivated && { status: 'HOLD' }),
        },
      })
      results.push({ truck_number, hold_id: updated.id, action: 'updated' })
      await prisma.auditLog.create({
        data: {
          action:       'UPDATE_HOLD',
          truck_number,
          user_id:      serviceUser.id,
          hold_id:      updated.id,
          details:      JSON.stringify({ source: 'salesforce', opportunityId, accountName, start_date, end_date, ...(reactivated && { reactivated_from_expired: true }) }),
        },
      })
    } else {
      const created = await prisma.hold.create({
        data: {
          truck_number,
          market,
          state,
          client_name:         accountName,
          start_date,
          end_date,
          status:              'HOLD',
          source:              'SALESFORCE',
          notes:               `Auto-created from Salesforce Opportunity ${opportunityId}${market ? '' : ' — market/state unknown, no live GPS for this truck'}`,
          created_by:          serviceUser.id,
          sfdc_opportunity_id: opportunityId,
          sfdc_hold_exp,
          expires_at:          sfdc_hold_exp,
        },
      })
      results.push({ truck_number, hold_id: created.id, action: 'created' })
      await prisma.auditLog.create({
        data: {
          action:       'CREATE_HOLD',
          truck_number,
          user_id:      serviceUser.id,
          hold_id:      created.id,
          details:      JSON.stringify({ source: 'salesforce', opportunityId, accountName, start_date, end_date }),
        },
      })
    }
  }

  return NextResponse.json({ results })
}

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { syncAttSoftHolds } from '@/lib/attSoftHolds'

/**
 * POST /api/holds/att-sync — bring AT&T soft holds in line with the schedule
 * (current month + next two; prior months released). Called when the
 * schedule grid loads; the cron (every 15 minutes) runs the same sync. See
 * lib/attSoftHolds.ts for the rules.
 */
export async function POST() {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const r = await syncAttSoftHolds({ createdBy: session.user.id })
    const released = r.releasedPriorMonths + r.releasedDuplicates + r.releasedPremise
    return NextResponse.json({ ...r, released })
  } catch (err) {
    console.error('[att-sync] failed:', err)
    return NextResponse.json({ error: 'AT&T soft-hold sync failed' }, { status: 500 })
  }
}

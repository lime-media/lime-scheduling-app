import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { auditHoldFeasibility } from '@/lib/holdAudit'

/**
 * GET /api/holds/infeasible
 *
 * Ops review list: active holds that cannot actually be served, recomputed live.
 *
 * Most entries will originate from the Salesforce and ATT sync paths, which
 * write without the feasibility gate on purpose. A hold can also appear here
 * long after it was booked cleanly, if a neighbouring job later moved.
 */
export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const result = await auditHoldFeasibility()
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[holds/infeasible] audit failed:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

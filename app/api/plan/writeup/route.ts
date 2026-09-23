/**
 * POST /api/plan/writeup — Claude drafts a client section and an internal
 * section from a finished plan. Numbers in the draft that are not in the plan
 * are returned alongside it, so nothing invented passes as the plan's.
 */

import { NextRequest, NextResponse } from 'next/server'
import { writePlanSummary } from '@/lib/planning/claude'
import { requireStaff, claudeErrorResponse } from '@/lib/planning/http'
import type { PlanResponse } from '@/lib/planning/run'

export const maxDuration = 300

export async function POST(req: NextRequest) {
  const denied = await requireStaff(req)
  if (denied) return denied

  let body: { plan?: PlanResponse; areaCount?: number; zipCount?: number; flagsSummary?: string[]; clientRequest?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body.plan || !Array.isArray(body.plan.routes) || !body.plan.pricing) {
    return NextResponse.json({ error: 'Run the plan first.' }, { status: 400 })
  }

  try {
    const result = await writePlanSummary({
      plan: body.plan,
      areaCount: Number(body.areaCount ?? 0),
      zipCount: Number(body.zipCount ?? 0),
      flagsSummary: Array.isArray(body.flagsSummary) ? body.flagsSummary.slice(0, 50).map(String) : [],
      clientRequest: typeof body.clientRequest === 'string' ? body.clientRequest : undefined,
    })
    return NextResponse.json(result)
  } catch (err) {
    return claudeErrorResponse(err, 'writeup')
  }
}

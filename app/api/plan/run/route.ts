/**
 * POST /api/plan/run — plan weekly coverage of many areas across the fleet.
 *
 * Internal staff only: the response carries truck assignments, repositioning
 * cost and fleet capacity, none of which may reach a client route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { runPlan, type PlanRequest } from '@/lib/planning/run'
import type { Area } from '@/lib/planning/areas'

export const maxDuration = 60

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
const isArea = (a: unknown): a is Area => {
  const x = a as Area
  return !!x && typeof x.id === 'string' && typeof x.name === 'string'
    && Number.isFinite(x.lat) && Number.isFinite(x.lng) && Array.isArray(x.zips)
}

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: PlanRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!Array.isArray(body.areas) || body.areas.length === 0 || !body.areas.every(isArea)) {
    return NextResponse.json({ error: 'Build the areas first.' }, { status: 400 })
  }
  if (body.areas.length > 200) return NextResponse.json({ error: 'Up to 200 areas per plan.' }, { status: 400 })
  if (body.model !== '3x12' && body.model !== '5x8') return NextResponse.json({ error: 'model must be 3x12 or 5x8' }, { status: 400 })
  if (!isDate(body.planStart) || !isDate(body.planThrough) || body.planThrough <= body.planStart) {
    return NextResponse.json({ error: 'Start and plan-through dates are required, with plan-through after start.' }, { status: 400 })
  }

  try {
    return NextResponse.json(await runPlan(body))
  } catch (err) {
    console.error('[plan/run] failed:', err)
    return NextResponse.json({ error: 'The plan could not be run. Check the server log.' }, { status: 500 })
  }
}

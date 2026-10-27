/**
 * GET /api/ops/opportunity-origins?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * LED opportunities created in Salesforce in the range (default: the last 8
 * Central weeks), split into made in the app and made directly in Salesforce,
 * week by week and by who made the direct ones (lib/opportunityOrigins.ts).
 * Any signed-in staff user.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { centralDate } from '@/lib/dateOnly'
import { isSfdcConfigured } from '@/lib/salesforceClient'
import { opportunityOrigins } from '@/lib/opportunityOrigins'

// A real calendar date: 2026-13-01 or 2026-02-30 would otherwise throw (or roll over) further in.
const isDate = (v: string | null): v is string =>
  !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().startsWith(v)

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isSfdcConfigured()) return NextResponse.json({ error: 'Salesforce is not configured.' }, { status: 503 })

  const sp = req.nextUrl.searchParams
  const to = isDate(sp.get('to')) ? sp.get('to')! : centralDate(new Date())
  // Seven weeks back: with the current week, 8 Central weeks.
  const from = isDate(sp.get('from')) ? sp.get('from')! : new Date(Date.parse(to + 'T00:00:00Z') - 7 * 7 * 86_400_000).toISOString().slice(0, 10)
  if (from > to) return NextResponse.json({ error: '`from` must be on or before `to`.' }, { status: 400 })

  try {
    return NextResponse.json(await opportunityOrigins(from, to))
  } catch (err) {
    console.error('[opportunity-origins] read failed:', err)
    return NextResponse.json({ error: "Opportunity origins couldn't be read. Try again shortly." }, { status: 502 })
  }
}

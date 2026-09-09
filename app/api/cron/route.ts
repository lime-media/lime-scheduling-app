import { NextRequest, NextResponse } from 'next/server'
import { refreshCache } from '@/lib/scheduleCache'

// Never cached, and given a generous budget. The sweep is serial: per-hold audit
// and status writes, a Salesforce round trip per Opportunity it closes, then
// SCHEDULED_QUERY and per-conflict MSSQL writes in detectConflicts. The first
// production run also faces the entire backlog that accumulated while the old
// in-process timer silently never fired, so it is far slower than steady state.
// 300s is the Pro ceiling; every stage is idempotent, so a run that still times
// out is retried by the next hour rather than losing work.
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

/**
 * Scheduled maintenance sweep — expires holds past their `expires_at`,
 * releases stale ATT_SOFT holds, and re-runs conflict detection.
 *
 * Invoked hourly by Vercel Cron (see vercel.json), which sends
 * `Authorization: Bearer $CRON_SECRET`. Safe to call by hand with the same
 * header to force a sweep.
 *
 * This replaces the in-process node-cron timer that used to be started from
 * app/layout.tsx. That timer could not work on serverless — the instance is
 * frozen as soon as the response is sent, so the hourly tick never arrived and
 * holds sat past their expiry forever, still blocking inventory.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron] CRON_SECRET is not set — refusing to run the sweep')
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  try {
    const summary = await refreshCache()
    return NextResponse.json({ ok: true, ...summary, ms: Date.now() - started })
  } catch (err) {
    console.error('[cron] sweep failed:', err)
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

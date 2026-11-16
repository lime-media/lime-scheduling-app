/**
 * GET /api/ops/led-requests
 *
 * The live bookings as LED campaign requests (lib/ledReadiness.ts), and
 * whether each can be sent: blocking issues stop it; warnings send with
 * something assumed that ops should check in LED; Ready ones can be sent
 * (lib/coreSend.ts), and a sent one shows LED's request. `send` says whether
 * sending is on here, and why not. Any signed-in staff user.
 * Bookings the Salesforce bot user made aren't sent to LED unless they're
 * Closed Won (lib/campaignRequests.ts leftOutOfLed): until then they come
 * back apart, as `excluded`, not as issues to fix.
 */

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { coreConfig } from '@/lib/coreClient'
import { isReady, loadLedBookings } from '@/lib/ledReadiness'
import { leftOutOfLed } from '@/lib/campaignRequests'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { bookings: current, sent } = await loadLedBookings()
    const all = current.filter(b => !leftOutOfLed(b))
    const summary = (b: (typeof current)[number]) => ({
      key: b.bookingKey,
      client: b.request.campaignName,
      won: b.won,
      start: b.request.startDate,
      end: b.request.endDate,
      markets: b.request.markets.map((m, i) => ({ name: b.marketNames[i], trucks: m.trucks })),
    })
    const excluded = current.filter(leftOutOfLed).map(summary).sort((a, b) => a.start.localeCompare(b.start))
    const rank = (blocked: boolean, issues: number) => (blocked ? 0 : issues > 0 ? 1 : 2)
    const bookings = all
      .map(b => {
        const row = sent.get(b.bookingKey)
        return {
          ...summary(b),
          issues: b.issues,
          ready: isReady(b),
          sent: row?.core_uid ? { coreUid: row.core_uid, requestId: row.request_id, at: row.last_sent_at } : null,
          lastError: row?.core_uid ? null : row?.last_error ?? null,
        }
      })
      .sort((a, b) => rank(!a.ready, a.issues.length) - rank(!b.ready, b.issues.length) || a.start.localeCompare(b.start))
    const config = coreConfig(process.env)
    return NextResponse.json({
      total: all.length,
      blocked: bookings.filter(b => !b.ready).length,
      bookings,
      excluded,
      send: config.ok ? { enabled: true } : { enabled: false, reason: config.reason },
    })
  } catch (err) {
    console.error('[led-requests] read failed:', err)
    return NextResponse.json({ error: "Bookings couldn't be read. Try again shortly." }, { status: 502 })
  }
}

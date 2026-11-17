/**
 * GET /api/ops/led-requests
 *
 * The live bookings as LED campaign requests (lib/ledReadiness.ts), and
 * whether each can be sent: blocking issues stop it; warnings send with
 * something assumed that ops should check in LED; Ready ones can be sent
 * (lib/coreSend.ts), and a sent one shows LED's request. A won one is
 * converted by the sweep (lib/coreConvert.ts) and shows LED's decision or
 * refusal. `send` and `convert` say whether each is on here, and why not. Any signed-in staff user.
 * Bookings the Salesforce bot user made aren't sent to LED unless they're
 * Closed Won (lib/campaignRequests.ts leftOutOfLed): until then they come
 * back apart, as `excluded`, not as issues to fix.
 */

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { coreConfig } from '@/lib/coreClient'
import { convertOff, isDecided, toConvert } from '@/lib/coreConvert'
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
    const converting = convertOff(process.env) === null
    const bookings = all
      .map(b => {
        const row = sent.get(b.bookingKey)
        return {
          ...summary(b),
          issues: b.issues,
          ready: isReady(b),
          // Only a booking won in every market converts (lib/coreConvert.ts toConvert).
          wholeWon: b.wholeWon,
          sent: row?.core_uid ? { coreUid: row.core_uid, requestId: row.request_id, at: row.last_sent_at } : null,
          // LED's decision once a won booking is converted (or declined) there.
          converted: row?.core_status === 'APPROVED' ? { programUid: row.program_uid ?? null } : null,
          declined: row?.core_status === 'DECLINED',
          // What LED decided beside, e.g. a decline because LED already runs the job by hand.
          decisionNote: isDecided(row) ? row?.last_error ?? null : null,
          // The sweep will try it: the same rule it uses (lib/coreConvert.ts toConvert).
          converting: converting && toConvert([b], sent).length > 0,
          // A send's refusal, or (won, sent) the conversion's, until it's decided.
          lastError: isDecided(row) || (row?.core_uid && !b.wholeWon) ? null : row?.last_error ?? null,
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
      convert: (off => off ? { enabled: false, reason: off } : { enabled: true })(convertOff(process.env)),
    })
  } catch (err) {
    console.error('[led-requests] read failed:', err)
    return NextResponse.json({ error: "Bookings couldn't be read. Try again shortly." }, { status: 502 })
  }
}

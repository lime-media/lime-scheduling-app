/**
 * Warn internal users before their reservations expire.
 *
 * A hold that passes expires_at is released automatically by expireHolds() and
 * the truck goes back in the pool. That is correct, but silent — the person who
 * placed it finds out by noticing it is gone. This sends one digest per user
 * ahead of that.
 *
 * Idempotency without a schema change
 * -----------------------------------
 * The cron runs every 15 minutes, so "expires within 24h" matches for ~96 consecutive runs.
 * Rather than add a warned_at column, a WARN_HOLD_EXPIRY audit row per hold is
 * the record — the same table already carries EXPIRE_HOLD and CREATE_HOLD, and
 * it survives redeploys and reruns.
 *
 * The record is keyed on the hold AND the expiry it warned about. Keying on the
 * hold alone silences it permanently after one warning, which breaks precisely
 * the workflow this exists to support: warn -> user extends -> the new expiry
 * arrives with no warning and the hold lapses silently. A new expires_at is a
 * new deadline and gets its own warning.
 */

import { prisma } from '@/lib/prisma'
import type { Hold } from '@prisma/client'
import { sendExpiringHoldsEmail } from '@/lib/email'
import type { ExpiringBooking } from '@/lib/emailTemplates'
import { APP_TIME_ZONE, centralDate } from '@/lib/dateOnly'
import { bookingCapStarts, bookingKey } from '@/lib/bookings'
import { STAFF_MIN_DAYS_BEFORE_START, lastExpiryDate } from '@/lib/holdExpiry'
import { extendOptions, signExtendToken } from '@/lib/extendLink'

/** When a hold lapses, as reps read it (Central time). */
const EXPIRES_AT = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: APP_TIME_ZONE, timeZoneName: 'short' })

export const WARN_ACTION = 'WARN_HOLD_EXPIRY'

/** How far ahead of expiry to warn. */
export const WARN_WINDOW_HOURS = 24

export type ExpiryWarningResult = {
  candidates: number
  warned: number
  recipients: number
  skipped_already_warned: number
  skipped_no_email: number
}

function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0]
}

/**
 * The app's address, for links in the email. NEXTAUTH_URL is one value for
 * Production and Preview, so a preview deployment (UAT) uses its branch URL
 * (Vercel's VERCEL_BRANCH_URL) or its links would open production.
 */
export function appUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.VERCEL_ENV === 'preview' && env.VERCEL_BRANCH_URL
    ? `https://${env.VERCEL_BRANCH_URL}`
    : env.NEXTAUTH_URL ?? 'https://led.lime-media.com'
  return url.replace(/\/$/, '')
}

const hoursLeft = (expiresAt: Date, now: Date) => Math.max(0, Math.round((expiresAt.getTime() - now.getTime()) / 3600_000))

/**
 * One reminder card per booking (lib/bookings.ts bookingKey; a hold with none
 * is its own): a booking is extended as one. Each card carries Extend links
 * for the days that stay within the booking's limit (2 days before its
 * earliest start), signed for the rep (lib/extendLink.ts); none when the
 * signing secret isn't set. Exported for tests.
 */
export function expiringBookings(holds: Hold[], now: Date, secret: string | undefined = process.env.NEXTAUTH_SECRET): ExpiringBooking[] {
  const groups = new Map<string, Hold[]>()
  for (const h of holds) {
    const key = bookingKey(h) ?? `hold:${h.id}`
    groups.set(key, [...(groups.get(key) ?? []), h])
  }
  const today = centralDate(now)
  return [...groups.values()].map(group => {
    // The booking's one expiry: the earliest, should older bookings differ.
    const first = [...group].sort((a, b) => (a.expires_at?.getTime() ?? 0) - (b.expires_at?.getTime() ?? 0))[0]
    const starts = group.map(h => toDateStr(h.start_date))
    // The server's cap rule (lib/bookingExpiry.ts capStarts), over the holds this email covers.
    const capFrom = bookingCapStarts(group.map(h => ({ start_date: toDateStr(h.start_date), status: h.status })), today).sort()[0]
    const lastDate = lastExpiryDate(capFrom, now, STAFF_MIN_DAYS_BEFORE_START)
    const expiresOn = first.expires_at ? centralDate(first.expires_at) : null
    // Extending sets every hold to one date: never earlier than a hold already expires.
    const latestOn = group.map(h => h.expires_at ? centralDate(h.expires_at) : '').sort().reverse()[0]
    const token = secret && first.expires_at
      ? signExtendToken({ holdId: first.id, userId: first.created_by, expiresAt: first.expires_at.toISOString() }, secret)
      : null
    // A client's pending extension request is answered on Reservations, not from here.
    const pending = group.some(h => h.status === 'EXTENSION_REQUESTED')
    const extend = token && expiresOn && !pending
      ? extendOptions(expiresOn, lastDate, latestOn).map(o => ({ days: o.days, label: o.label, url: `${appUrl()}/extend?t=${encodeURIComponent(token)}&d=${o.days}` }))
      : []
    return {
      clientName: first.client_name,
      markets:    [...new Set(group.map(h => h.market).filter(Boolean))],
      trucks:     [...new Set(group.map(h => h.truck_number))],
      startDate:  starts.sort()[0],
      endDate:    group.map(h => toDateStr(h.end_date)).sort().reverse()[0],
      // In Central time, as the rep's confirmation and Salesforce's Hold Exp give it.
      expiresAt:  first.expires_at ? EXPIRES_AT.format(first.expires_at) : 'unknown',
      hoursLeft:  first.expires_at ? hoursLeft(first.expires_at, now) : 0,
      extend,
    }
  })
}

export async function warnExpiringHolds(now = new Date()): Promise<ExpiryWarningResult> {
  const cutoff = new Date(now.getTime() + WARN_WINDOW_HOURS * 3600_000)

  // Only reservations a person placed internally and that can still lapse.
  // COMMITTED is exempt from expiry entirely, ATT_SOFT is an auto-generated
  // placeholder nobody is waiting on, and client/Salesforce holds are chased
  // through their own channels.
  const candidates = await prisma.hold.findMany({
    where: {
      status:     { in: ['HOLD', 'EXTENSION_REQUESTED'] },
      source:     'INTERNAL',
      expires_at: { gt: now, lte: cutoff },
    },
    orderBy: { expires_at: 'asc' },
  })

  const result: ExpiryWarningResult = {
    candidates: candidates.length,
    warned: 0,
    recipients: 0,
    skipped_already_warned: 0,
    skipped_no_email: 0,
  }
  if (candidates.length === 0) return result

  const warnRows = await prisma.auditLog.findMany({
    where: { action: WARN_ACTION, hold_id: { in: candidates.map(h => h.id) } },
    select: { hold_id: true, details: true },
  })

  // "hold X, for expiry T" — extending a hold changes T, so the new deadline is
  // unwarned and will be warned about on the next sweep.
  const warnedFor = new Set<string>()
  for (const row of warnRows) {
    if (!row.hold_id) continue
    let warnedExpiry: string | null = null
    try {
      warnedExpiry = JSON.parse(row.details ?? '{}').expires_at ?? null
    } catch { /* unparseable detail — treat as a warning for an unknown expiry */ }
    warnedFor.add(`${row.hold_id}|${warnedExpiry ? new Date(warnedExpiry).toISOString() : 'unknown'}`)
  }

  const pending = candidates.filter(
    h => !warnedFor.has(`${h.id}|${h.expires_at ? h.expires_at.toISOString() : 'unknown'}`),
  )
  result.skipped_already_warned = candidates.length - pending.length
  if (pending.length === 0) return result

  // One digest per person who placed them.
  const byCreator = new Map<string, typeof pending>()
  for (const h of pending) {
    const list = byCreator.get(h.created_by) ?? []
    list.push(h)
    byCreator.set(h.created_by, list)
  }

  const users = await prisma.user.findMany({
    where: { id: { in: [...byCreator.keys()] } },
    select: { id: true, email: true, name: true },
  })
  const userById = new Map(users.map(u => [u.id, u]))

  for (const [creatorId, holds] of byCreator) {
    const user = userById.get(creatorId)
    const to = user?.email || process.env.NOTIFY_EMAIL
    if (!to) {
      // No address to send to. Left unwarned deliberately rather than marked —
      // if an address appears later, the warning still goes out.
      result.skipped_no_email += holds.length
      console.warn(`[expiry-warn] no email for creator ${creatorId}; ${holds.length} hold(s) unwarned`)
      continue
    }

    // Extend links act as the rep without sign-in: only in the rep's own inbox,
    // not the NOTIFY_EMAIL fallback.
    const bookings = expiringBookings(holds, now, user?.email ? process.env.NEXTAUTH_SECRET : undefined)

    try {
      await sendExpiringHoldsEmail({
        to,
        recipientName: user?.name ?? '',
        bookings,
        reservationsUrl: `${appUrl()}/hold-requests`,
      })
    } catch (err) {
      // Do not mark as warned — a send failure should retry on the next sweep.
      console.error(`[expiry-warn] send failed for ${to}:`, err)
      continue
    }

    // Mark only after a successful send.
    await prisma.auditLog.createMany({
      data: holds.map(h => ({
        action:       WARN_ACTION,
        truck_number: h.truck_number,
        user_id:      h.created_by,
        hold_id:      h.id,
        details:      JSON.stringify({
          expires_at: h.expires_at,
          hours_left: h.expires_at ? hoursLeft(h.expires_at, now) : null,
          sent_to:    to,
        }),
      })),
    })

    result.warned += holds.length
    result.recipients += 1
  }

  return result
}

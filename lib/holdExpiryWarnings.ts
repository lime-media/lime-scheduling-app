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
 * The cron runs hourly, so "expires within 24h" matches for 24 consecutive runs.
 * Rather than add a warned_at column, a WARN_HOLD_EXPIRY audit row per hold is
 * the record — the same table already carries EXPIRE_HOLD and CREATE_HOLD, and
 * it survives redeploys and reruns. A hold warned once is never warned again,
 * even if the window is re-evaluated.
 */

import { prisma } from '@/lib/prisma'
import { sendExpiringHoldsEmail, type ExpiringHoldSummary } from '@/lib/email'

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

  const alreadyWarned = new Set(
    (await prisma.auditLog.findMany({
      where: { action: WARN_ACTION, hold_id: { in: candidates.map(h => h.id) } },
      select: { hold_id: true },
    })).map(r => r.hold_id).filter((id): id is string => id !== null),
  )

  const pending = candidates.filter(h => !alreadyWarned.has(h.id))
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

    const summaries: ExpiringHoldSummary[] = holds.map(h => ({
      truckNumber: h.truck_number,
      clientName:  h.client_name,
      market:      h.market,
      startDate:   toDateStr(h.start_date),
      endDate:     toDateStr(h.end_date),
      expiresAt:   h.expires_at ? h.expires_at.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown',
      hoursLeft:   h.expires_at
        ? Math.max(0, Math.round((h.expires_at.getTime() - now.getTime()) / 3600_000))
        : 0,
    }))

    try {
      await sendExpiringHoldsEmail({
        to,
        recipientName: user?.name ?? '',
        holds: summaries,
      })
    } catch (err) {
      // Do not mark as warned — a send failure should retry on the next sweep.
      console.error(`[expiry-warn] send failed for ${to}:`, err)
      continue
    }

    // Mark only after a successful send.
    for (const h of holds) {
      await prisma.auditLog.create({
        data: {
          action:       WARN_ACTION,
          truck_number: h.truck_number,
          user_id:      h.created_by,
          hold_id:      h.id,
          details:      JSON.stringify({
            expires_at: h.expires_at,
            hours_left: summaries.find(s => s.truckNumber === h.truck_number)?.hoursLeft,
            sent_to:    to,
          }),
        },
      })
    }

    result.warned += holds.length
    result.recipients += 1
  }

  return result
}

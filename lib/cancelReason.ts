/**
 * A cancel reason (lib/cancelBooking.ts). Its own module, with no server
 * imports, so the confirm page (app/cancel) shares the limit.
 */

/** The longest reason kept (app_holds.cancel_reason). */
export const CANCEL_REASON_MAX = 1000

/** A cancel reason as stored: trimmed, at most CANCEL_REASON_MAX characters, null when empty. Pure. */
export function cleanCancelReason(reason: unknown): string | null {
  if (typeof reason !== 'string') return null
  const r = reason.trim().slice(0, CANCEL_REASON_MAX)
  return r || null
}

/**
 * Whether a booking's expired rows read as cancelled, and why: when the
 * booking's latest release was a cancel. Cancel sets expires_at to the moment
 * it cancels, so the expired row released last carries the mark. Holds added
 * to the booking later that then lapse on their own release after it, and the
 * booking reads as an ordinary lapse; markets that ended before the cancel
 * don't change it. Pure.
 */
export function cancelledOf(rows: { status: string; expires_at: string | null; cancelled_at: string | null; cancel_reason: string | null }[]): { reason: string | null } | null {
  const expired = rows.filter(r => r.status === 'EXPIRED')
  if (expired.length === 0) return null
  const last = expired.reduce((a, b) => ((b.expires_at ?? '') > (a.expires_at ?? '') ? b : a))
  return last.cancelled_at ? { reason: last.cancel_reason } : null
}

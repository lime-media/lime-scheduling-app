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

/** A cancelled booking's reason, from any of its rows that carries one; null when not cancelled. Pure. */
export function cancelledOf(rows: { status: string; cancelled_at: string | null; cancel_reason: string | null }[]): { reason: string | null } | null {
  const c = rows.find(r => r.status === 'EXPIRED' && r.cancelled_at)
  return c ? { reason: c.cancel_reason } : null
}

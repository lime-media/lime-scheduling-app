import type { Prisma } from '@prisma/client'

/**
 * A hold occupies its truck only while it is BOTH:
 *   - in a status that reserves the truck (not EXPIRED, and for most read
 *     paths not ATT_SOFT either), and
 *   - not past its `expires_at`.
 *
 * The second half matters because `expires_at` passing is what *makes* a hold
 * stale — flipping the row to status EXPIRED is a background write done by
 * expireHolds(), driven by the /api/cron sweep. Until that write lands the row
 * still reads as HOLD, so any query that trusts `status` alone keeps the truck
 * blocked. Deriving staleness here keeps availability correct even when the
 * sweep is late, failing, or has not run yet.
 *
 * Holds with a null `expires_at` never expire on their own (internal and ATT
 * holds, plus Salesforce pushes that carry no Hold Exp date) and always count
 * as active.
 *
 * COMMITTED is exempt from the expiry half entirely. expireHolds() only ever
 * matches HOLD and EXTENSION_REQUESTED, so a committed booking is immune to the
 * sweep — and committing a hold does not clear `expires_at`
 * (app/api/holds/[id]/route.ts writes `status` alone). Without the exemption a
 * client hold committed by ops would silently vanish from the grid, map,
 * inventory, availability and conflict detection 72h later, while the
 * Reservations page still showed it as active with no badge. That is a
 * double-booking waiting to happen, so status wins over expiry here.
 */
export function activeHoldWhere(
  opts: { excludeAttSoft?: boolean; now?: Date } = {}
): Prisma.HoldWhereInput {
  const { excludeAttSoft = false, now = new Date() } = opts
  return {
    status: excludeAttSoft ? { notIn: ['ATT_SOFT', 'EXPIRED'] } : { not: 'EXPIRED' },
    OR: [
      { status: 'COMMITTED' },
      { expires_at: null },
      { expires_at: { gte: now } },
    ],
  }
}

import { holdReservesNow } from '@/lib/holdFilters'

// Holds pushed in from Salesforce are attributed to this service user, and
// automated actions on those holds (e.g. auto-release once a real LED shift
// is scheduled) are logged under it too.
export const SFDC_SERVICE_USER_EMAIL = 'sfdc-integration@lime-media.com'

/**
 * Which pushed trucks to mirror as SALESFORCE holds. The quote tools (single,
 * multi-market, client portal) create Opportunities WITH the LED fields set
 * and hold the trucks themselves (source INTERNAL / CLIENT, linked by
 * sfdc_opportunity_id), so Salesforce's push of those is an echo: mirroring it
 * would double-book. Only trucks the app holds RIGHT NOW are skipped — a
 * quote-only log or an expired hold reserves nothing, so when a rep fills in
 * the LED fields to make it a real booking, it is mirrored like any other.
 */
export function trucksToMirror(
  pushedTrucks: string[],
  linkedHolds: { truck_number: string; source: string; status: string; expires_at: Date | null }[],
  now: Date = new Date(),
): string[] {
  const held = new Set(linkedHolds.filter(h => h.source !== 'SALESFORCE' && holdReservesNow(h, now)).map(h => h.truck_number))
  return pushedTrucks.filter(t => !held.has(t))
}

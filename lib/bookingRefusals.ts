/**
 * What a person is told when a truck can't be booked: clients (portal,
 * partner/MCP) and staff (internal holds API, staff MCP tokens).
 * Pure, so it is tested directly (tests/attSoft.test.ts).
 *
 * A client never books over anything, AT&T soft holds included: only staff
 * release a soft hold, for a booking, from the app. And a client never learns
 * who holds the truck or what it is scheduled for.
 */

export type FeasibilityVerdict = { ok: boolean; overridable?: boolean; reason?: string; detail?: string } | null

/** The refusal to show a client, or null when the booking may go ahead. */
export function clientBookingRefusal(truckNumber: string, conflictingHolds: number, feasibility: FeasibilityVerdict): string | null {
  const unavailable = `Truck ${truckNumber} is not available on these dates.`
  if (conflictingHolds > 0) return unavailable
  // A lookup failure (null) is tolerated, as on every other path.
  if (!feasibility || feasibility.ok) return null
  // Overridable = only an AT&T soft hold is in the way; BOOKED details name
  // the program or hold. Neither is the client's to see.
  if (feasibility.overridable || feasibility.reason === 'BOOKED') return unavailable
  return feasibility.detail ?? `Truck ${truckNumber} cannot serve these dates.`
}

/**
 * The refusal for the staff paths (internal holds API, staff MCP tokens):
 * soft holds block there too, but staff are told it is AT&T's, so they know
 * to check with operations and release it in the app.
 */
export function staffBookingRefusal(truckNumber: string, conflictingStatuses: string[], feasibility: FeasibilityVerdict): string | null {
  if (conflictingStatuses.includes('ATT_SOFT')) {
    return `Truck ${truckNumber} is reserved for AT&T (soft hold) on these dates. It can only be released for a booking from the app, after checking with operations.`
  }
  if (conflictingStatuses.length > 0) return 'Conflict: truck already has a hold in this date range'
  if (!feasibility || feasibility.ok) return null
  // Refused even when only an AT&T soft hold would be stranded (overridable).
  return `Cannot place hold — ${feasibility.detail ?? 'truck cannot serve these dates'}`
}

/**
 * Why a truck is busy, as the partner/MCP availability API says it. That API
 * serves client tokens, so it never names a program, a client or AT&T.
 */
export function partnerClashDetail(clash: { yieldable?: boolean; start: string; end: string }): string {
  return clash.yieldable ? 'Not available on these dates.' : `Booked from ${clash.start} to ${clash.end}.`
}

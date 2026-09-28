/**
 * One colour language for truck status, shared by the internal and client
 * views so a rep and a client looking at the same truck are reading the same
 * colours.
 *
 *   green   available: free to book, in BOTH views
 *   gray    scheduled: booked on the LED schedule — the same gray the client
 *           view uses for "Booked"
 *   soft gray  committed reservation: won in Salesforce (Closed Won), not yet
 *           on the LED schedule. Still blocks the truck, never expires.
 *   yellow  reservation (a hold, including a client's hold request)
 *   blue    AT&T soft hold
 *   orange  maintenance
 *
 * The client view shows every kind of booked as plain gray "Booked"; the
 * internal view breaks booked out into the colours above. Green never means
 * booked anywhere.
 */

/** Every status a schedule-grid cell can have. The maps below must cover each one. */
export type DisplayStatus =
  | 'EMPTY' | 'DEPARTING' | 'SCHEDULED_LED' | 'HOLD_TENTATIVE' | 'HOLD_REQUEST'
  | 'COMMITTED_NOT_SET' | 'ATT_SOFT' | 'MAINTENANCE'

// ── Schedule grid cells (Tailwind classes) ───────────────────────────────────

// Committed carries an inset border as well as the softer gray, so it reads
// apart from scheduled in the grid exactly as it does in the legend.
const COMMITTED_CELL = 'bg-gray-200 hover:bg-gray-300 ring-1 ring-inset ring-gray-400'

export const GRID_COLORS: Record<DisplayStatus, string> = {
  EMPTY:              'bg-green-500 hover:bg-green-600',
  DEPARTING:          'bg-green-500 hover:bg-green-600',
  SCHEDULED_LED:      'bg-gray-300 hover:bg-gray-400',
  HOLD_TENTATIVE:     'bg-yellow-400 hover:bg-yellow-500',
  HOLD_REQUEST:       'bg-yellow-400 hover:bg-yellow-500',
  COMMITTED_NOT_SET:  COMMITTED_CELL,
  ATT_SOFT:           'bg-blue-400 hover:bg-blue-500',
  MAINTENANCE:        'bg-orange-400 hover:bg-orange-500',
}

// Client view: available = green, anything booked or requested by anyone
// else = gray "Booked". A client never sees what kind of booking it is.
const BOOKED_CELL = 'bg-gray-300 hover:bg-gray-400'
export const CLIENT_GRID_COLORS: Record<DisplayStatus, string> = {
  EMPTY:              'bg-green-500 hover:bg-green-600',
  DEPARTING:          'bg-green-500 hover:bg-green-600',
  SCHEDULED_LED:      BOOKED_CELL,
  HOLD_TENTATIVE:     BOOKED_CELL,
  HOLD_REQUEST:       BOOKED_CELL,
  COMMITTED_NOT_SET:  BOOKED_CELL,
  ATT_SOFT:           BOOKED_CELL,
  MAINTENANCE:        BOOKED_CELL,
}

// Legend swatches (the solid colour of each grid cell). Only statuses with a
// legend entry: HOLD_REQUEST shows as a reservation, DEPARTING as available.
export const LEGEND_SWATCH = {
  EMPTY:              'bg-green-500',
  SCHEDULED_LED:      'bg-gray-300',
  MAINTENANCE:        'bg-orange-400',
  HOLD_TENTATIVE:     'bg-yellow-400',
  COMMITTED_NOT_SET:  'bg-gray-200 ring-1 ring-inset ring-gray-400',
  ATT_SOFT:           'bg-blue-400',
} as const

/**
 * Text on a solid cell of each status (used where cells carry numbers or
 * labels, e.g. the Planner). Every pairing is at least 4.5:1 — dark text on
 * orange, not white (white on orange-400 is about 2.2:1).
 */
export const CELL_TEXT: Record<DisplayStatus, string> = {
  EMPTY:              'text-green-950',
  DEPARTING:          'text-green-950',
  SCHEDULED_LED:      'text-gray-900',
  HOLD_TENTATIVE:     'text-yellow-950',
  HOLD_REQUEST:       'text-yellow-950',
  COMMITTED_NOT_SET:  'text-gray-800',
  ATT_SOFT:           'text-blue-950',
  MAINTENANCE:        'text-orange-950',
}

// ── Status badges (pill backgrounds) ─────────────────────────────────────────

export const STATUS_BADGE: Record<DisplayStatus, string> = {
  EMPTY:             'bg-green-100 text-green-800',
  DEPARTING:         'bg-green-100 text-green-800',
  SCHEDULED_LED:     'bg-gray-200 text-gray-800',
  HOLD_TENTATIVE:    'bg-yellow-100 text-yellow-800',
  HOLD_REQUEST:      'bg-yellow-100 text-yellow-800',
  COMMITTED_NOT_SET: 'bg-gray-100 text-gray-600 ring-1 ring-inset ring-gray-400',
  ATT_SOFT:          'bg-blue-100 text-blue-800',
  MAINTENANCE:       'bg-orange-100 text-orange-800',
}

/** For a status the maps do not know: neutral, never green (green means available). */
export const UNKNOWN_BADGE = 'bg-gray-100 text-gray-600'

/** Client view badges: available, or booked. */
export const CLIENT_BADGE = { available: 'bg-green-100 text-green-800', booked: 'bg-gray-100 text-gray-600' } as const

// ── Map pins (hex) ───────────────────────────────────────────────────────────

export const PIN = {
  available: '#16a34a', // green-600
  att:       '#60a5fa', // blue-400, the grid's AT&T soft hold
  scheduled: '#9ca3af', // gray-400 (a pin needs a shade darker than the grid's gray-300)
  reservation: '#ca8a04', // yellow-600
  committed: '#d1d5db',   // gray-300: won, softer than scheduled
  booked:    '#9ca3af', // gray-400, client view
} as const

// ── Labels ───────────────────────────────────────────────────────────────────

/** A hold (status HOLD). */
export const RESERVATION_LABEL = 'Reservation'

/** A committed reservation (status COMMITTED): won in Salesforce, not yet on the LED schedule. */
export const COMMITTED_LABEL = 'Committed (won)'

export const ATT_SOFT_LABEL = 'AT&T soft hold'

/** What the client view calls anything that is not available. */
export const BOOKED_LABEL = 'Booked'

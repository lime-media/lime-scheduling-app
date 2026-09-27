/**
 * One colour language for truck status, shared by the internal and client
 * views so a rep and a client looking at the same truck are reading the same
 * colours.
 *
 *   green   available: free to book, in BOTH views
 *   slate   scheduled: booked on the LED schedule (internal detail of "booked")
 *   yellow  reservation (a hold, whether or not it was committed) / requested
 *   blue    AT&T soft hold
 *   orange  maintenance
 *
 * The client view shows every kind of booked as plain gray "Booked"; the
 * internal view breaks booked out into the colours above. Green never means
 * booked anywhere.
 */

// ── Schedule grid cells (Tailwind classes) ───────────────────────────────────

export const GRID_COLORS: Record<string, string> = {
  EMPTY:              'bg-green-500 hover:bg-green-600',
  DEPARTING:          'bg-green-500 hover:bg-green-600',
  SCHEDULED_LED:      'bg-slate-500 hover:bg-slate-600',
  HOLD_TENTATIVE:     'bg-yellow-400 hover:bg-yellow-500',
  HOLD_REQUEST:       'bg-yellow-400 hover:bg-yellow-500',
  COMMITTED_NOT_SET:  'bg-yellow-400 hover:bg-yellow-500',
  ATT_SOFT:           'bg-blue-400 hover:bg-blue-500',
  MAINTENANCE:        'bg-orange-400 hover:bg-orange-500',
}

// Client view: available = green, anything booked/unavailable = gray.
export const CLIENT_GRID_COLORS: Record<string, string> = {
  EMPTY:              'bg-green-500 hover:bg-green-600',
  DEPARTING:          'bg-green-500 hover:bg-green-600',
  SCHEDULED_LED:      'bg-gray-300 hover:bg-gray-400',
  HOLD_TENTATIVE:     'bg-gray-300 hover:bg-gray-400',
  COMMITTED_NOT_SET:  'bg-gray-300 hover:bg-gray-400',
  ATT_SOFT:           'bg-gray-300 hover:bg-gray-400',
  MAINTENANCE:        'bg-gray-300 hover:bg-gray-400',
  HOLD_REQUEST:       'bg-yellow-400 hover:bg-yellow-500',
}

// Legend swatches (the solid colour of each grid cell).
export const LEGEND_SWATCH: Record<string, string> = {
  EMPTY:              'bg-green-500',
  SCHEDULED_LED:      'bg-slate-500',
  MAINTENANCE:        'bg-orange-400',
  HOLD_TENTATIVE:     'bg-yellow-400',
  COMMITTED_NOT_SET:  'bg-yellow-400',
  ATT_SOFT:           'bg-blue-400',
  HOLD_REQUEST:       'bg-yellow-400',
}

// ── Status badges (pill backgrounds) ─────────────────────────────────────────

export const STATUS_BADGE: Record<string, string> = {
  EMPTY:             'bg-green-100 text-green-800',
  SCHEDULED_LED:     'bg-slate-200 text-slate-800',
  HOLD_TENTATIVE:    'bg-yellow-100 text-yellow-800',
  COMMITTED_NOT_SET: 'bg-yellow-100 text-yellow-800',
  ATT_SOFT:          'bg-blue-100 text-blue-800',
  MAINTENANCE:       'bg-orange-100 text-orange-800',
}

// ── Map pins (hex) ───────────────────────────────────────────────────────────

export const PIN = {
  available: '#16a34a', // green-600
  scheduled: '#64748b', // slate-500
  reservation: '#ca8a04', // yellow-600
  booked:    '#9ca3af', // gray-400, client view
} as const

// ── Labels ───────────────────────────────────────────────────────────────────

/** A hold is a reservation, whether or not it was committed; one label, one colour. */
export const RESERVATION_LABEL = 'Reservation'

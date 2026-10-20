'use client'

/**
 * How long a reservation from the quote tool holds its trucks: 3 days by
 * default, up to MAX_HOLD_DAYS. Shows the date it will lapse, from the same
 * rule the server applies (lib/holdExpiry.ts), including when a campaign
 * starting soon cuts it short. A booking has one expiry, capped by its
 * earliest start; lengths that start won't allow are
 * disabled, not offered and cut short. Shared by the single- and multi-market
 * quotes.
 */

import { useEffect } from 'react'
import { DEFAULT_HOLD_DAYS, MAX_HOLD_DAYS, availableHoldDays, bookingHoldExpiry } from '@/lib/holdExpiry'

export { DEFAULT_HOLD_DAYS }

// Central time, as the booking confirmation states it.
const fmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago', timeZoneName: 'short' })

export function HoldLength({ days, onChange, startDates }: {
  days: number
  onChange: (days: number) => void
  /** The booking's start dates, YYYY-MM-DD. A booking has one expiry, capped by the earliest of them. */
  startDates: string[]
}) {
  const starts = startDates.filter(Boolean)
  // One clock for the expiry and the options, so they agree.
  const now = new Date()
  const lapse = starts.length ? bookingHoldExpiry(starts, days, now) : null
  const available = new Set(availableHoldDays(starts, now))
  const longest = Math.max(...available)
  // Dates moved so the chosen length no longer fits: fall back to the longest that does.
  useEffect(() => {
    if (!available.has(days)) onChange(longest)
  }, [days, longest]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-gray-700">
      <label htmlFor="hold-days" className="font-medium">Hold the trucks for</label>
      <select id="hold-days" value={days} onChange={e => onChange(Number(e.target.value))}
        className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500">
        {Array.from({ length: MAX_HOLD_DAYS }, (_, i) => i + 1).map(n => (
          <option key={n} value={n} disabled={!available.has(n)}>
            {n} day{n === 1 ? '' : 's'}{n === DEFAULT_HOLD_DAYS ? ' (standard)' : ''}{available.has(n) ? '' : ' — campaign starts too soon'}
          </option>
        ))}
      </select>
      {lapse && (
        <span className="text-xs text-gray-500">
          lapses {fmt.format(lapse.expiresAt)}
          {lapse.cappedByStart && (
            <span className="text-amber-700"> · cut short: a booking is held until 3 days before its first market starts</span>
          )}
          {lapse.atMinimum && (
            <span className="text-amber-700"> · the 24-hour minimum: the first market starts too soon for a longer hold</span>
          )}
        </span>
      )}
    </div>
  )
}

'use client'

/**
 * How long a reservation from the quote tool holds its trucks: 3 days by
 * default, up to MAX_HOLD_DAYS. Shows the date it will lapse, from the same
 * rule the server applies (lib/holdExpiry.ts), including when a campaign
 * starting soon cuts it short. Shared by the single- and multi-market quotes.
 */

import { DEFAULT_HOLD_DAYS, MAX_HOLD_DAYS, holdExpiry } from '@/lib/holdExpiry'

export { DEFAULT_HOLD_DAYS }

// Central time, as the booking confirmation states it.
const fmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago', timeZoneName: 'short' })

export function HoldLength({ days, onChange, startDates }: {
  days: number
  onChange: (days: number) => void
  /** The start date each hold is capped by, YYYY-MM-DD, as the server computes it; the soonest decides the earliest lapse. */
  startDates: string[]
}) {
  const starts = startDates.filter(Boolean).sort()
  // One clock for every start, so equal lengths compare equal.
  const now = new Date()
  const first = starts.length ? holdExpiry(starts[0], days, now) : null
  const varies = starts.length > 1 && starts.some(s => holdExpiry(s, days, now).expiresAt.getTime() !== first!.expiresAt.getTime())
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-gray-700">
      <label htmlFor="hold-days" className="font-medium">Hold the trucks for</label>
      <select id="hold-days" value={days} onChange={e => onChange(Number(e.target.value))}
        className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500">
        {Array.from({ length: MAX_HOLD_DAYS }, (_, i) => i + 1).map(n => (
          <option key={n} value={n}>{n} day{n === 1 ? '' : 's'}{n === DEFAULT_HOLD_DAYS ? ' (standard)' : ''}</option>
        ))}
      </select>
      {first && (
        <span className="text-xs text-gray-500">
          {varies ? 'first lapses' : 'lapses'} {fmt.format(first.expiresAt)}
          {first.cappedByStart && (
            <span className="text-amber-700"> · cut short: a hold ends 3 days before its campaign starts</span>
          )}
          {first.atMinimum && (
            <span className="text-amber-700"> · the 24-hour minimum: the campaign starts too soon for a longer hold</span>
          )}
        </span>
      )}
    </div>
  )
}

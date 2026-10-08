/**
 * The pure rules behind AT&T soft holds (see lib/attSoftHolds.ts): which
 * client is AT&T, which trucks are AT&T's, and which months the rolling
 * window covers. No database,
 * so they can be tested and imported anywhere.
 */

/** The client AT&T books through. Compared trimmed and case-insensitive. */
export const ATT_CLIENT = '160over90'

/** Months kept ahead, counting the current one. */
export const WINDOW_MONTHS = 3

/**
 * A truck is AT&T's when it worked MORE than this many days for 160over90 in
 * a single month (each month counted on its own, never added together).
 */
export const ATT_MIN_DAYS = 5

/**
 * Through this day of the month, the prior month still counts: AT&T's
 * commitments for a new month drag into its first days, so a truck that was
 * AT&T's last month keeps its soft hold while the new month's shifts arrive.
 * From the next day on, only the current month counts.
 */
export const PRIOR_MONTH_GRACE_DAY = 10

const iso = (d: Date) => d.toISOString().slice(0, 10)
const utc = (s: string) => new Date(s + 'T00:00:00Z')

/** The months the window covers, as [holdStart, monthEnd]; the current month starts today. */
export function softHoldWindow(today: string): { start: string; end: string; label: string }[] {
  const t = utc(today)
  return Array.from({ length: WINDOW_MONTHS }, (_, i) => {
    const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + i, 1))
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + i + 1, 0))
    return {
      start: i === 0 ? today : iso(first),
      end: iso(last),
      label: first.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    }
  })
}

/**
 * A client name reduced to lowercase letters and digits, so "160over90",
 * "160 Over 90", "160over90, Inc." all compare the same.
 */
export const normalizeClient = (client: unknown): string => String(client ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Whether a client is AT&T's agency. "Contains" after normalising, like the
 * planner's reservation rule — so an edit to the client record ("160over90
 * Inc") cannot make every AT&T truck look like someone else's. The SQL in
 * lib/attSoftHolds.ts (ATT_CLIENT_SQL) applies the same test.
 */
export const isAttClient = (client: unknown): boolean => normalizeClient(client).includes(normalizeClient(ATT_CLIENT))

/**
 * Safety valve on releasing soft holds because trucks stopped counting as
 * AT&T's: a run that would release more than this share of the soft holds
 * (and more than MASS_RELEASE_MIN of them) releases none and reports why.
 * A real roster change happens a few trucks at a time; a mass drop means the
 * schedule has not landed yet or the data is wrong.
 */
export const MASS_RELEASE_SHARE = 0.25
export const MASS_RELEASE_MIN = 10

/** Why a run must not release soft holds for "not AT&T's", or null when it may. */
export function releaseBlockedReason(opts: { attTrucks: number; softHolds: number; wouldRelease: number }): string | null {
  if (opts.softHolds > 0 && opts.attTrucks === 0) return 'no truck counts as AT&T this run (the client match or the schedule query found nothing)'
  if (opts.wouldRelease > MASS_RELEASE_MIN && opts.wouldRelease > opts.softHolds * MASS_RELEASE_SHARE) {
    return `would release ${opts.wouldRelease} of ${opts.softHolds} soft holds at once (limit: ${Math.round(MASS_RELEASE_SHARE * 100)}% and more than ${MASS_RELEASE_MIN})`
  }
  return null
}

/** The months whose 160over90 days decide which trucks are AT&T's, as of `today`. */
export function attLookback(today: string): { current: { from: string; to: string }; prior: { from: string; to: string } | null } {
  const t = utc(today)
  const y = t.getUTCFullYear(), m = t.getUTCMonth()
  const month = (k: number) => ({ from: iso(new Date(Date.UTC(y, m + k, 1))), to: iso(new Date(Date.UTC(y, m + k + 1, 0))) })
  return { current: month(0), prior: t.getUTCDate() <= PRIOR_MONTH_GRACE_DAY ? month(-1) : null }
}

/**
 * Whether a truck is AT&T's, from its 160over90 days in each counted month.
 * More than ATT_MIN_DAYS in the current month; or, through the 10th, in the
 * prior month instead. `prior` is ignored when the lookback has no prior month.
 */
export function isAttTruck(days: { current: number; prior: number }, lookback: ReturnType<typeof attLookback>): boolean {
  return days.current > ATT_MIN_DAYS || (lookback.prior !== null && days.prior > ATT_MIN_DAYS)
}

/**
 * Whether an AT&T soft hold gives way on one day: only when another client's
 * shift is on THAT day. Soft holds cover whole months, so voiding the whole
 * hold for any overlapping shift would turn a month green for a one-day job
 * elsewhere — the grid, map and planner all use this per-day rule.
 */
export function softHoldYieldsOn(date: string, otherClientShifts: { shift_start: string; shift_end: string }[] | undefined): boolean {
  return (otherClientShifts ?? []).some(s => s.shift_start <= date && s.shift_end >= date)
}

/**
 * The parts of [start, end] not covered by any of `taken` — the days a truck
 * still needs a soft hold for, after its existing soft holds and any dates
 * someone released for a booking. Dates are YYYY-MM-DD. Pure.
 */
export function freeRanges(start: string, end: string, taken: { start: string; end: string }[]): { start: string; end: string }[] {
  const next = (d: string) => iso(new Date(utc(d).getTime() + 864e5))
  const prev = (d: string) => iso(new Date(utc(d).getTime() - 864e5))
  const blocks = taken.filter(t => t.end >= start && t.start <= end).sort((a, b) => a.start.localeCompare(b.start))
  const out: { start: string; end: string }[] = []
  let cursor = start
  for (const b of blocks) {
    if (b.start > cursor) out.push({ start: cursor, end: prev(b.start) < end ? prev(b.start) : end })
    if (b.end >= cursor) cursor = next(b.end)
    if (cursor > end) return out
  }
  if (cursor <= end) out.push({ start: cursor, end })
  return out
}

/** Release rows (lib/attSoftRelease.ts) carry this origination. */
export const ATT_RELEASE_ORIGINATION = 'att_soft_release'

/** A release is for one booking: at most this many days at a time. */
export const ATT_RELEASE_MAX_DAYS = 31

/** The words shown before any release of an AT&T soft hold. Exactly as operations asked. */
export const ATT_RELEASE_WARNING =
  'Ensure with operations this works, and it only releases for the specific dates of the new booking so that there is no conflict.'

/**
 * The parts of [holdStart, holdEnd] left after removing [start, end]: zero,
 * one or two ranges. Pure, so it can be tested.
 */
export function carve(holdStart: string, holdEnd: string, start: string, end: string): { start: string; end: string }[] {
  if (end < holdStart || start > holdEnd) return [{ start: holdStart, end: holdEnd }]
  const out: { start: string; end: string }[] = []
  if (start > holdStart) out.push({ start: holdStart, end: addDaysIso(start, -1) })
  if (end < holdEnd) out.push({ start: addDaysIso(end, 1), end: holdEnd })
  return out
}

const addDaysIso = (d: string, n: number) => iso(new Date(utc(d).getTime() + n * 864e5))

/** Why a release range is refused, or null when it is fine: valid dates, one booking long. */
export function validateReleaseRange(start: string, end: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
    return 'Release dates must be YYYY-MM-DD, end on or after start.'
  }
  const n = Math.round((utc(end).getTime() - utc(start).getTime()) / 864e5) + 1
  if (n > ATT_RELEASE_MAX_DAYS) return `A release covers one booking: at most ${ATT_RELEASE_MAX_DAYS} days. Release longer bookings in parts, with operations.`
  return null
}

type Range = { start: string; end: string }
type Where = { market: string; state: string }

/**
 * Sync step 3b: which live soft holds sit over a release record, and the
 * pieces each one is cut down to. A release is final, so a soft hold written
 * over one (a release that landed mid-sync) is cut back around it.
 */
export function planReleaseCuts(
  soft: ({ id: string; truck_number: string } & Range)[],
  releases: ({ truck_number: string } & Range)[],
): { id: string; keep: Range[] }[] {
  const out: { id: string; keep: Range[] }[] = []
  for (const h of soft) {
    const over = releases.filter(r => r.truck_number === h.truck_number && r.start <= h.end && r.end >= h.start)
    if (!over.length) continue
    let keep: Range[] = [{ start: h.start, end: h.end }]
    for (const r of over) keep = keep.flatMap(p => carve(p.start, p.end, r.start, r.end))
    out.push({ id: h.id, keep })
  }
  return out
}

/**
 * Sync step 3c: soft holds written without a market get the market of the
 * truck's latest 160over90 work, so the strand check can protect them.
 */
export function planMarketBackfill(
  soft: { id: string; truck_number: string; market: string }[],
  lastMarket: Map<string, Where>,
): ({ id: string } & Where)[] {
  return soft.flatMap(h => {
    const where = lastMarket.get(h.truck_number)
    return !h.market && where?.market ? [{ id: h.id, ...where }] : []
  })
}

/**
 * Sync step 4: the soft holds to create. For each AT&T truck and window
 * month, only the days neither soft-held nor released for a booking, each
 * carrying the truck's latest 160over90 market.
 */
export function planSoftHoldFill(opts: {
  window: (Range & { label: string })[]
  trucks: string[]
  live: ({ truck_number: string } & Range)[]
  releases: ({ truck_number: string } & Range)[]
  lastMarket: Map<string, Where>
}): ({ truck_number: string; label: string } & Range & Where)[] {
  const of = (rows: ({ truck_number: string } & Range)[], t: string) => rows.filter(r => r.truck_number === t)
  const out: ({ truck_number: string; label: string } & Range & Where)[] = []
  for (const m of opts.window) {
    for (const truck_number of [...opts.trucks].sort()) {
      const where = opts.lastMarket.get(truck_number) ?? { market: '', state: '' }
      for (const g of freeRanges(m.start, m.end, [...of(opts.live, truck_number), ...of(opts.releases, truck_number)])) {
        out.push({ truck_number, label: m.label, ...g, ...where })
      }
    }
  }
  return out
}

/**
 * A person's change to the AT&T truck list for a date range
 * (app_att_roster_overrides): ADD puts a truck on the list for those dates,
 * REMOVE takes it off. After the end date the automatic rule applies again.
 */
export type RosterOverride = { truck_number: string; action: 'ADD' | 'REMOVE' } & Range

/**
 * What the overrides mean for one sync, over `span` (the window's months):
 *
 * - `addTrucks`: trucks on the list only because someone added them. They
 *   keep and get soft holds like AT&T's own, but only on their added dates.
 * - `blocks`: per truck, the dates that must have no soft hold — every
 *   REMOVE range, and for an added-only truck every date outside its ADD
 *   ranges. The sync treats these like release records: cut, never filled.
 *
 * An ADD on a truck that is AT&T's anyway changes nothing. Pure.
 */
export function rosterPlan(opts: {
  overrides: RosterOverride[]
  autoTrucks: Set<string>
  span: Range
}): { addTrucks: Set<string>; blocks: ({ truck_number: string } & Range)[] } {
  const live = opts.overrides.filter(o => o.end >= opts.span.start && o.start <= opts.span.end)
  const blocks: ({ truck_number: string } & Range)[] = live
    .filter(o => o.action === 'REMOVE')
    .map(o => ({ truck_number: o.truck_number, start: o.start, end: o.end }))
  const addTrucks = new Set(live.filter(o => o.action === 'ADD' && !opts.autoTrucks.has(o.truck_number)).map(o => o.truck_number))
  for (const t of addTrucks) {
    const added = live.filter(o => o.action === 'ADD' && o.truck_number === t)
    for (const g of freeRanges(opts.span.start, opts.span.end, added)) blocks.push({ truck_number: t, ...g })
  }
  return { addTrucks, blocks }
}

/**
 * A list change lasts at most this many days. Changes are meant to end and
 * hand back to the automatic rule; a year is long enough for any real swap
 * and keeps one mistyped date from changing the list for decades.
 */
export const ATT_LIST_MAX_DAYS = 366

/** Why a list change is refused, or null when it is fine. Dates are YYYY-MM-DD. */
export function validateRosterOverride(o: { action: string; start: string; end: string; reason: string }, today: string): string | null {
  if (o.action !== 'ADD' && o.action !== 'REMOVE') return 'Choose add or remove.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.start) || !/^\d{4}-\d{2}-\d{2}$/.test(o.end) || o.end < o.start) {
    return 'Dates must be YYYY-MM-DD, end on or after start.'
  }
  if (o.end < today) return 'The end date has already passed.'
  if (Math.round((utc(o.end).getTime() - utc(o.start).getTime()) / 864e5) + 1 > ATT_LIST_MAX_DAYS) {
    return `A list change lasts at most ${ATT_LIST_MAX_DAYS} days. Make a new one when it ends, if it still applies.`
  }
  if (!o.reason.trim()) return 'Say why, so the team knows later.'
  return null
}

/** Can this record be reinstated as a live hold? Release records never can. */
export function reinstateBlockedByRelease(origination: string | null | undefined): string | null {
  return origination === ATT_RELEASE_ORIGINATION
    ? 'This is an AT&T soft-hold release record, not a reservation. Undo it from the Conflicts page.'
    : null
}

/**
 * Per-truck job timelines.
 *
 * Availability is not a filter over dates — it is an insert into a sequence.
 * To know whether a truck can take a campaign we need to know where it is
 * BEFORE the campaign and where it is committed to be AFTER it, so every
 * booking has to carry a location, not just a date range.
 *
 * Both sources already carry one: SCHEDULED_QUERY returns market/state/program
 * per scheduled day, and Hold rows carry market/state. This module merges them
 * into one ordered timeline per truck.
 *
 * Schedule rows arrive as one row per day (ps.start_time cast to DATE), so
 * consecutive days of the same program in the same market are merged back into
 * a single job — the same grouping the schedule grid and chat context perform.
 */

/** A hold in this status is a placeholder that may be voided, not a commitment. */
export const YIELDABLE_HOLD_STATUSES = new Set(['ATT_SOFT'])

export type TruckJobSource = 'SCHEDULE' | 'HOLD'

export type TruckJob = {
  start: string          // YYYY-MM-DD, inclusive
  end: string            // YYYY-MM-DD, inclusive
  market: string
  state: string
  /**
   * The market's own coordinates, from standard_market_lookup. Present only
   * where the LED schema carries bounding boxes. When set this is authoritative
   * — it is the market the team selected, not a guess from its name.
   */
  lat?: number
  lng?: number
  program?: string
  source: TruckJobSource
  status?: string
  /** True when this job may be displaced by a new booking (soft holds only). */
  yieldable: boolean
}

export type DayRow = {
  truckNumber: string
  date: string
  market: string
  state: string
  program?: string
  lat?: number
  lng?: number
}

function nextDayStr(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().split('T')[0]
}

/**
 * Merge per-day schedule rows into contiguous jobs, keyed by truck.
 * Days are merged only when the program AND market match and the dates are
 * adjacent — a truck that moves markets mid-week produces two jobs, which is
 * exactly what the chain check needs to see.
 */
export function groupDaysIntoJobs(rows: DayRow[]): Map<string, TruckJob[]> {
  const byTruck = new Map<string, DayRow[]>()
  for (const row of rows) {
    if (!row.date) continue
    const list = byTruck.get(row.truckNumber) ?? []
    list.push(row)
    byTruck.set(row.truckNumber, list)
  }

  const out = new Map<string, TruckJob[]>()
  for (const [truckNumber, days] of byTruck) {
    days.sort((a, b) => a.date.localeCompare(b.date))
    const jobs: TruckJob[] = []
    for (const day of days) {
      const last = jobs[jobs.length - 1]
      const contiguous =
        last !== undefined
        && last.market === day.market
        && last.program === day.program
        && (last.end === day.date || nextDayStr(last.end) === day.date)
      if (contiguous) {
        last.end = day.date > last.end ? day.date : last.end
      } else {
        jobs.push({
          start: day.date,
          end: day.date,
          market: day.market,
          state: day.state,
          program: day.program,
          lat: day.lat,
          lng: day.lng,
          source: 'SCHEDULE',
          yieldable: false,
        })
      }
    }
    out.set(truckNumber, jobs)
  }
  return out
}

export type HoldLike = {
  truck_number: string
  start_date: string
  end_date: string
  market: string
  state: string
  status: string
}

/**
 * Merge grouped schedule jobs with holds into one ordered timeline per truck.
 */
export function buildTruckTimelines(
  scheduleDays: DayRow[],
  holds: HoldLike[],
): Map<string, TruckJob[]> {
  const timelines = groupDaysIntoJobs(scheduleDays)

  for (const h of holds) {
    if (!h.start_date || !h.end_date) continue
    const jobs = timelines.get(h.truck_number) ?? []
    jobs.push({
      start: h.start_date,
      end: h.end_date,
      market: h.market ?? '',
      state: h.state ?? '',
      source: 'HOLD',
      status: h.status,
      yieldable: YIELDABLE_HOLD_STATUSES.has(h.status),
    })
    timelines.set(h.truck_number, jobs)
  }

  for (const jobs of timelines.values()) {
    jobs.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
  }
  return timelines
}

/**
 * The job that determines where the truck will be when the campaign starts.
 *
 * Only a job that is RUNNING NOW or SCHEDULED between now and the campaign
 * qualifies. A job that already finished says nothing about where the truck is
 * — trucks are repositioned between campaigns all the time, so a market it left
 * three weeks ago is not evidence of anything. In that case the caller should
 * fall back to live GPS, which is the only thing that knows where it actually
 * sits today.
 *
 * Concretely, a job qualifies when it ends on or after `today` (so it is either
 * in progress or still upcoming) and before the campaign begins.
 *
 * Yieldable (ATT_SOFT) holds never qualify. They are placeholders that may be
 * voided, and they are written with an empty market anyway — treating one as an
 * origin would gate the truck's departure behind a hold it may never serve, and
 * raise a spurious "market could not be geocoded" warning on a blank string.
 *
 * When several jobs qualify, the LATEST one wins: two campaigns booked before
 * the quoted dates means the truck ends up wherever the second one leaves it.
 */
export function findPredecessor(
  jobs: TruckJob[],
  campaignStart: string,
  today: string,
): TruckJob | null {
  let best: TruckJob | null = null
  for (const j of jobs) {
    if (j.yieldable) continue
    if (j.end >= today && j.end < campaignStart && (best === null || j.end > best.end)) {
      best = j
    }
  }
  return best
}

/** First job that begins strictly after the campaign ends. */
export function findSuccessor(jobs: TruckJob[], campaignEnd: string): TruckJob | null {
  let best: TruckJob | null = null
  for (const j of jobs) {
    if (j.start > campaignEnd && (best === null || j.start < best.start)) best = j
  }
  return best
}

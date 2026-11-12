/**
 * A booking as a CampaignIQ campaign request (source SCHEDULING_APP).
 *
 * Every reservation becomes a request in Core, kept in step while it is held,
 * converted into an LED program when the deal is won, declined when it lapses
 * or is lost. This module only builds what would be sent: one request per
 * booking (lib/bookings.ts bookingKey), one request market per market of the
 * booking, with its trucks, the days of the week it runs and its shift length.
 * Field names follow the agreed scope; the Core client maps them onto the
 * contract.
 *
 * It also says what stops a booking converting cleanly, for the "needs ops"
 * list. Blocking: Core would refuse the convert, or the app can't say which
 * market a truck works. Warnings: it converts, but something was assumed that
 * ops should check in LED. Pure.
 */

import { createHash } from 'crypto'
import { NO_TRUCK, bookingKey, isMultiMarket } from '@/lib/bookings'
import { SHORT_RANGE_MAX_DAYS, billedDaysPerWeek, countCalendarDays } from '@/lib/pricing/schedule'
import { realJobNumber } from '@/lib/jobNumber'

/** A hold as the builder reads it. Dates YYYY-MM-DD. */
export type RequestHold = {
  id: string
  truck_number: string
  market: string
  state: string
  client_name: string
  start_date: string
  end_date: string
  status: string
  campaign_group_id: string | null
  sfdc_opportunity_id: string | null
  sfdc_account_id: string | null
  sfdc_job_number: string | null
  /** Who made its Salesforce opportunity (the reconcile fills it; null until then). */
  sfdc_created_by_id: string | null
  standard_market_uid: string | null
  quoted_total: number | null
  features: string | null
}

/** Core's shift lengths (CampaignDuration), by the quote's operating hours. */
export type Duration = 'FULL_DAY' | 'EXTENDED_FULL_DAY' | 'TWELVE_HOUR_SHIFT'
const DURATION: Record<number, Duration> = { 8: 'FULL_DAY', 10: 'EXTENDED_FULL_DAY', 12: 'TWELVE_HOUR_SHIFT' }
/** The shortest Core shift that covers the hours sold (quotes allow any 8–12: 9 → 10, 11 → 12); null outside 8–12. */
const shiftFor = (hours: number): Duration | null => hours >= 8 && hours <= 12 ? DURATION[[8, 10, 12].find(h => h >= hours)!] : null

/** Sun–Sat, the same flags as LED's client_program_markets. */
export type DayFlags = { sunday: boolean; monday: boolean; tuesday: boolean; wednesday: boolean; thursday: boolean; friday: boolean; saturday: boolean }
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

export type RequestMarket = {
  /** The booking's own key for this market: its campaign group, else its market. */
  key: string
  standardMarketUid: string | null
  /** The market as the hold names it, sent when it has no standard market. */
  otherMarketName: string | null
  startDate: string
  endDate: string
  duration: Duration
  days: DayFlags
  trucks: string[]
}

export type CampaignRequest = {
  /**
   * The key the booking was first sent under (app_campaign_requests.external_ref),
   * else its key now: a revision gives the booking a new key but keeps this,
   * so Core keeps one request, and a repeated create returns it.
   */
  externalRef: string
  campaignName: string
  clientUid: string | null
  startDate: string
  endDate: string
  /** The booking's quoted total; null when any market has no price (a Salesforce-made hold). */
  soldAmount: number | null
  jobNumber: string | null
  markets: RequestMarket[]
}

export type IssueKind =
  | 'no_led_client' | 'market_label' | 'no_standard_market' | 'no_job_number'
  | 'no_trucks' | 'days_not_confirmed' | 'hours_not_confirmed' | 'hours_off_shift' | 'hours_rounded' | 'shared_truck'

export type Issue = { kind: IssueKind; blocking: boolean; message: string; markets?: string[]; trucks?: string[] }

/**
 * `bookingKey`: the booking's key now. `won`: any hold is Closed Won. `marketNames`: each market as the holds name
 * it, in `request.markets` order. `holdsEnd`: the last day any live hold
 * reserves a truck (travel included), which can be after `request.endDate`.
 */
export type BookingRequest = { bookingKey: string; request: CampaignRequest; issues: Issue[]; won: boolean; marketNames: string[]; holdsEnd: string }

/**
 * The one rule for the Salesforce bot's deals (Andrew, 2026-11-12; lib/sfdcBots.ts):
 * they block availability like any booking but go to LED only once Closed Won.
 * The send (lib/coreSend.ts) and the LED Readiness list both ask this.
 */
export const leftOutOfLed = (b: { creator: 'bot' | 'person' | 'unknown'; won: boolean }): boolean => b.creator === 'bot' && !b.won

/** A Salesforce hold that names several markets in one label ("Multi-market: Austin, Dallas"). */
export const isMarketLabel = (market: string) => /^\s*multi-market\s*:/i.test(market)

const LIVE = new Set(['HOLD', 'EXTENSION_REQUESTED', 'COMMITTED'])

type Features = { daysPerWeek?: unknown; operatingHours?: unknown; requestedStart?: unknown; requestedEnd?: unknown }
function featuresOf(h: RequestHold): Features {
  if (!h.features) return {}
  try {
    const f = JSON.parse(h.features) as unknown
    return f && typeof f === 'object' && !Array.isArray(f) ? f as Features : {}
  } catch {
    return {}
  }
}

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const dow = (date: string) => new Date(date + 'T00:00:00Z').getUTCDay()
const flags = (on: (day: number) => boolean): DayFlags =>
  Object.fromEntries(DAY_NAMES.map((name, i) => [name, on(i)])) as DayFlags

/**
 * The days of the week a market runs, as the quote billed them
 * (lib/pricing/schedule.ts billedDaysPerWeek): a range of six days or fewer
 * runs every day; 7 every day; 6 Mon–Sat; 5 Mon–Fri; 3 the start's weekday and
 * the two after it, as the planner bills it (lib/planning/order.ts soloWorks).
 * `confirmed` is false when the quote carried no schedule: every day is sent
 * and ops narrows it in LED.
 */
export function marketDays(start: string, end: string, daysPerWeek: number | null): { days: DayFlags; confirmed: boolean } {
  const perWeek = billedDaysPerWeek(start, end, daysPerWeek ?? 7)
  const confirmed = daysPerWeek !== null || countCalendarDays(start, end) <= SHORT_RANGE_MAX_DAYS
  if (perWeek === 3) {
    const first = dow(start)
    return { days: flags(d => (d - first + 7) % 7 < 3), confirmed }
  }
  if (perWeek === 6) return { days: flags(d => d !== 0), confirmed }
  if (perWeek === 5) return { days: flags(d => d !== 0 && d !== 6), confirmed }
  return { days: flags(() => true), confirmed }
}

const placeKey = (h: RequestHold) => `${h.market.trim().toLowerCase()}|${h.state.trim().toLowerCase()}`

/**
 * The market a hold belongs to within its booking: a multi-market quote's
 * campaign group (one per market line), else LED's standard market, else the
 * market text. `located`: the standard market the booking's other holds give
 * the same market text, so a hold the sweep hasn't located yet stays in its
 * market instead of splitting off as an unlocated one.
 */
function marketKey(h: RequestHold, located: Map<string, string>): string {
  if (isMultiMarket(h)) return h.campaign_group_id!
  return (h.standard_market_uid ?? located.get(placeKey(h)))?.toLowerCase() ?? placeKey(h)
}

const placeName = (h: RequestHold) =>
  h.market.includes(',') || !h.state.trim() ? h.market.trim() : `${h.market.trim()}, ${h.state.trim()}`

/**
 * One booking's live holds as a campaign request, with what stands in the way
 * of converting it. `clientUidOf` gives the LED client linked to a Salesforce
 * account (app_led_client_links); `externalRefOf` the ref a booking was first
 * sent to Core under (app_campaign_requests), null for one never sent. Null
 * when the booking has no live hold.
 */
export function buildRequest(holds: RequestHold[], clientUidOf: (accountId: string) => string | null, externalRefOf: (bookingKey: string) => string | null): BookingRequest | null {
  const live = holds.filter(h => LIVE.has(h.status))
  if (live.length === 0) return null
  const first = [...live].sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id.localeCompare(b.id))[0]
  const issues: Issue[] = []

  const located = new Map<string, string>()
  for (const h of live) if (h.standard_market_uid && !located.has(placeKey(h))) located.set(placeKey(h), h.standard_market_uid)
  const byMarket = new Map<string, RequestHold[]>()
  for (const h of live) {
    const key = marketKey(h, located)
    const rows = byMarket.get(key)
    if (rows) rows.push(h)
    else byMarket.set(key, [h])
  }

  const unconfirmedDays: string[] = []
  const unconfirmedHours: string[] = []
  const roundedHours: string[] = []
  const offShiftHours: string[] = []
  const names = new Map<string, string>()
  const markets: RequestMarket[] = [...byMarket].map(([key, rows]) => {
    const f = rows.map(featuresOf)
    // The dates asked for, inside the holds' own (which can be wider by travel
    // days). Dates outside them are stale: an edit re-dated the holds and left
    // the quote's dates behind, so the holds' dates are used instead.
    const holdStart = rows.map(r => r.start_date).sort()[0]
    const holdEnd = rows.map(r => r.end_date).sort().reverse()[0]
    const askedStart = f.map(x => x.requestedStart).filter(isDate).sort()[0]
    const askedEnd = f.map(x => x.requestedEnd).filter(isDate).sort().reverse()[0]
    const fits = askedStart && askedEnd && askedStart >= holdStart && askedEnd <= holdEnd && askedStart <= askedEnd
    const startDate = fits ? askedStart : holdStart
    const endDate = fits ? askedEnd : holdEnd
    // Holds of one market can disagree (a Salesforce-made booking): the
    // widest schedule is sent, unconfirmed, so no sold day is lost.
    const schedules = [...new Set(f.map(x => x.daysPerWeek).filter((d): d is number => d === 3 || d === 5 || d === 6 || d === 7))]
    const perWeek = schedules.length === 0 ? null : Math.max(...schedules)
    // The longest hours sold that fit a shift, so no truck's day is cut short;
    // `rounded` when any hours sold aren't exactly that shift.
    const sold = f.map(x => x.operatingHours).filter((h): h is number => typeof h === 'number')
    const fitting = sold.filter(h => shiftFor(h) !== null)
    const hours = fitting.length > 0 ? Math.max(...fitting) : null
    const duration = hours === null ? null : shiftFor(hours)
    const offShift = sold.length > 0
    const { days, confirmed } = marketDays(startDate, endDate, perWeek)
    const name = placeName(rows[0])
    names.set(key, name)
    if (!confirmed || schedules.length > 1) unconfirmedDays.push(name)
    if (duration === null) (offShift ? offShiftHours : unconfirmedHours).push(name)
    else if (sold.some(h => DURATION[h] !== duration)) roundedHours.push(name)
    const uid = rows.find(r => r.standard_market_uid)?.standard_market_uid ?? null
    return {
      key,
      standardMarketUid: uid,
      otherMarketName: uid ? null : name,
      startDate,
      endDate,
      duration: duration ?? 'FULL_DAY',
      days,
      trucks: [...new Set(rows.map(r => r.truck_number.trim()).filter(t => !NO_TRUCK.has(t)))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    }
  }).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.key.localeCompare(b.key))

  const accountId = live.map(h => h.sfdc_account_id).find(Boolean) ?? null
  const clientUid = accountId ? clientUidOf(accountId) : null
  if (!clientUid) issues.push({ kind: 'no_led_client', blocking: true, message: accountId ? 'Its Salesforce account is not linked to an LED client: link it on Reservations.' : 'It has no Salesforce account to link to an LED client.' })

  const labelled = markets.filter(m => m.otherMarketName && isMarketLabel(m.otherMarketName))
  const empty = markets.filter(m => m.trucks.length === 0)
  if (empty.length > 0) issues.push({ kind: 'no_trucks', blocking: true, message: 'No truck is assigned; assign one before it converts.', markets: empty.map(m => names.get(m.key)!) })

  if (labelled.length > 0) issues.push({ kind: 'market_label', blocking: true, message: 'Salesforce gave one label for several markets; each truck needs its market.', markets: labelled.map(m => m.otherMarketName!), trucks: labelled.flatMap(m => m.trucks) })

  const unlocated = markets.filter(m => m.otherMarketName && !isMarketLabel(m.otherMarketName))
  if (unlocated.length > 0) issues.push({ kind: 'no_standard_market', blocking: true, message: 'Not on LED\'s market list; ops assigns a standard market before it converts.', markets: unlocated.map(m => m.otherMarketName!) })

  const jobNumber = live.map(h => realJobNumber(h.sfdc_job_number)).find(Boolean) ?? null
  const won = live.some(h => h.status === 'COMMITTED')
  if (won && !jobNumber) issues.push({ kind: 'no_job_number', blocking: true, message: 'Won, but Salesforce has no job number for it yet.' })

  if (unconfirmedDays.length > 0) issues.push({ kind: 'days_not_confirmed', blocking: false, message: 'No schedule on the quote: every day is sent; narrow the days in LED.', markets: unconfirmedDays })
  if (unconfirmedHours.length > 0) issues.push({ kind: 'hours_not_confirmed', blocking: false, message: 'No hours on the quote: 8-hour shifts are sent; change them in LED if needed.', markets: unconfirmedHours })
  if (offShiftHours.length > 0) issues.push({ kind: 'hours_off_shift', blocking: false, message: 'The hours sold fit no LED shift (8 to 12 hours): 8-hour shifts are sent; set the shift times in LED.', markets: offShiftHours })

  if (roundedHours.length > 0) issues.push({ kind: 'hours_rounded', blocking: false, message: 'The hours sold aren\'t an LED shift length; the next longer shift is sent: set the shift times in LED.', markets: roundedHours })

  const marketsOf = new Map<string, number>()
  for (const m of markets) for (const t of m.trucks) marketsOf.set(t, (marketsOf.get(t) ?? 0) + 1)
  const shared = [...marketsOf].filter(([, n]) => n > 1).map(([t]) => t)
  if (shared.length > 0) issues.push({ kind: 'shared_truck', blocking: false, message: 'A truck works more than one market; check its LED shifts don\'t overlap.', trucks: shared })

  // One price per market line (campaign group): every hold carries its line's total.
  const lineTotals = new Map<string, number | null>()
  // Grouped as the Reservations card groups them (lib/bookings.ts summarizeBooking), so the two agree.
  for (const h of live) if (!lineTotals.has(h.campaign_group_id ?? '')) lineTotals.set(h.campaign_group_id ?? '', h.quoted_total)
  const totals = [...lineTotals.values()]

  const key = bookingKey(first) ?? first.id
  return {
    bookingKey: key,
    request: {
      externalRef: externalRefOf(key) ?? key,
      campaignName: first.client_name.trim(),
      clientUid,
      startDate: markets.map(m => m.startDate).sort()[0],
      endDate: markets.map(m => m.endDate).sort().reverse()[0],
      soldAmount: totals.some(t => t === null) ? null : Math.round(totals.reduce<number>((n, t) => n + (t ?? 0), 0) * 100) / 100,
      jobNumber,
      markets,
    },
    issues,
    won,
    marketNames: markets.map(m => names.get(m.key)!),
    holdsEnd: live.map(h => h.end_date).sort().reverse()[0],
  }
}

/** Live holds grouped into bookings, each as a request. */
export function buildRequests(holds: RequestHold[], clientUidOf: (accountId: string) => string | null, externalRefOf: (bookingKey: string) => string | null): BookingRequest[] {
  const bookings = new Map<string, RequestHold[]>()
  for (const h of holds) {
    const key = bookingKey(h) ?? h.id
    const rows = bookings.get(key)
    if (rows) rows.push(h)
    else bookings.set(key, [h])
  }
  return [...bookings.values()].map(rows => buildRequest(rows, clientUidOf, externalRefOf)).filter((r): r is BookingRequest => r !== null)
}

/**
 * A fingerprint of what would be sent, stored after each send
 * (app_campaign_requests.last_sent_hash), so an unchanged booking isn't sent
 * again. Key order is fixed by the builder.
 */
export function requestFingerprint(request: CampaignRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex')
}

/**
 * A booking as a CampaignIQ campaign request (lib/campaignRequests.ts).
 *
 * Run with: npm test
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { eq, section } from './harness'
import { buildRequest, buildRequests, marketDays, requestFingerprint, type RequestHold } from '@/lib/campaignRequests'

const DALLAS = '11111111-1111-1111-1111-111111111111'
const AUSTIN = '22222222-2222-2222-2222-222222222222'
const ACCOUNT = '001Hs00002abcDEFGH'
const CLIENT = '33333333-3333-3333-3333-333333333333'
const linked = (a: string) => (a === ACCOUNT ? CLIENT : null)
const unsent = () => null

let n = 0
const hold = (over: Partial<RequestHold> = {}): RequestHold => ({
  id: `h${++n}`,
  truck_number: '0101',
  market: 'Dallas, TX',
  state: 'TX',
  client_name: 'Acme Outdoor',
  start_date: '2026-12-07',
  end_date: '2026-12-20',
  status: 'HOLD',
  campaign_group_id: 'cg_1',
  sfdc_opportunity_id: '006Hs00000000001',
  sfdc_account_id: ACCOUNT,
  sfdc_job_number: null,
  standard_market_uid: DALLAS,
  quoted_total: 20000,
  features: JSON.stringify({ daysPerWeek: 5, operatingHours: 10 }),
  ...over,
})
const on = (d: Record<string, boolean>) => Object.entries(d).filter(([, v]) => v).map(([k]) => k.slice(0, 3)).join(' ')

section('marketDays: the days of the week, as the quote billed them')
eq('Mon–Fri', on(marketDays('2026-12-07', '2026-12-20', 5).days), 'mon tue wed thu fri')
eq('Mon–Sat', on(marketDays('2026-12-07', '2026-12-20', 6).days), 'mon tue wed thu fri sat')
eq('7 days', on(marketDays('2026-12-07', '2026-12-20', 7).days), 'sun mon tue wed thu fri sat')
eq('3 days from a Tuesday start: Tue–Thu', on(marketDays('2026-12-08', '2026-12-28', 3).days), 'tue wed thu')
eq('3 days from a Saturday start wraps: Sat, Sun, Mon', on(marketDays('2026-12-12', '2027-01-02', 3).days), 'sun mon sat')
eq('a short range runs every day, whatever was asked', on(marketDays('2026-12-07', '2026-12-10', 5).days), 'sun mon tue wed thu fri sat')
eq('no schedule: every day, not confirmed', marketDays('2026-12-07', '2026-12-20', null), { days: marketDays('2026-12-07', '2026-12-20', 7).days, confirmed: false })
eq('no schedule on a short range is still confirmed', marketDays('2026-12-07', '2026-12-09', null).confirmed, true)

section('buildRequest: one market')
const one = buildRequest([hold(), hold({ truck_number: '0099' })], linked, unsent)!
eq('one market, both trucks, numeric order', one.request.markets.map(m => m.trucks), [['0099', '0101']])
eq('standard market sent, no other name', [one.request.markets[0].standardMarketUid, one.request.markets[0].otherMarketName], [DALLAS, null])
eq('10 hours → EXTENDED_FULL_DAY', one.request.markets[0].duration, 'EXTENDED_FULL_DAY')
eq('the linked LED client', one.request.clientUid, CLIENT)
eq('external ref is the booking key', one.request.externalRef, 'cg_1')
eq('one line price, not one per truck', one.request.soldAmount, 20000)
eq('nothing for ops', one.issues, [])

const kinds = (r: ReturnType<typeof buildRequest>) => r!.issues.map(i => `${i.kind}${i.blocking ? '!' : ''}`)

section('buildRequest: dates')
const asked = buildRequest([hold({ start_date: '2026-12-05', end_date: '2026-12-22', features: JSON.stringify({ daysPerWeek: 5, operatingHours: 8, requestedStart: '2026-12-07', requestedEnd: '2026-12-20' }) })], linked, unsent)!
eq('the dates asked for, not the hold\'s travel days', [asked.request.markets[0].startDate, asked.request.markets[0].endDate], ['2026-12-07', '2026-12-20'])
eq('8 hours → FULL_DAY', asked.request.markets[0].duration, 'FULL_DAY')
eq('9 hours (staff chat) → the 10-hour shift that covers it, flagged', [buildRequest([hold({ features: JSON.stringify({ daysPerWeek: 5, operatingHours: 9 }) })], linked, unsent)!.request.markets[0].duration, kinds(buildRequest([hold({ features: JSON.stringify({ daysPerWeek: 5, operatingHours: 9 }) })], linked, unsent))], ['EXTENDED_FULL_DAY', ['hours_rounded']])
eq('an unassigned truck isn\'t sent', buildRequest([hold(), hold({ truck_number: 'UNASSIGNED' })], linked, unsent)!.request.markets[0].trucks, ['0101'])

section('buildRequest: multi-market')
const mm = buildRequest([
  hold({ campaign_group_id: 'mm_b1_1', quoted_total: 10000 }),
  hold({ campaign_group_id: 'mm_b1_2', market: 'Austin, TX', standard_market_uid: AUSTIN, start_date: '2026-12-14', end_date: '2026-12-27', quoted_total: 5000, truck_number: '0202' }),
], linked, unsent)!
eq('one request for the booking', mm.request.externalRef, 'mm_b1')
eq('a market per line, by start date', mm.request.markets.map(m => m.standardMarketUid), [DALLAS, AUSTIN])
eq('the request spans every market', [mm.request.startDate, mm.request.endDate], ['2026-12-07', '2026-12-27'])
eq('sold amount adds the lines', mm.request.soldAmount, 15000)
const shared = buildRequest([hold({ campaign_group_id: 'mm_b2_1' }), hold({ campaign_group_id: 'mm_b2_2', market: 'Austin, TX', standard_market_uid: AUSTIN })], linked, unsent)!
eq('a truck in two markets is flagged, not blocking', shared.issues.map(i => [i.kind, i.blocking, i.trucks]), [['shared_truck', false, ['0101']]])

section('buildRequest: what needs ops')
eq('no linked LED client blocks', kinds(buildRequest([hold({ sfdc_account_id: '001Hs00002zzzZZZZZ' })], linked, unsent)), ['no_led_client!'])
eq('no account at all blocks', kinds(buildRequest([hold({ sfdc_account_id: null })], linked, unsent)), ['no_led_client!'])
eq('an unlinked account carries the account to link', buildRequest([hold({ sfdc_account_id: '001Hs00002zzzZZZZZ' })], linked, unsent)!.issues.map(i => i.accountId), ['001Hs00002zzzZZZZZ'])
eq('no account: nothing to link', buildRequest([hold({ sfdc_account_id: null })], linked, unsent)!.issues.map(i => i.accountId ?? null), [null])
const label = buildRequest([
  hold({ market: 'Multi-market: Austin, Dallas', state: '', standard_market_uid: null, features: null, quoted_total: null }),
  hold({ market: 'Multi-market: Austin, Dallas', state: '', standard_market_uid: null, features: null, quoted_total: null, truck_number: '0202' }),
], linked, unsent)!
eq('a Salesforce multi-market label blocks, naming its trucks', label.issues[0], { kind: 'market_label', blocking: true, message: 'Salesforce gave one label for several markets; each truck needs its market.', markets: ['Multi-market: Austin, Dallas'], trucks: ['0101', '0202'] })
eq('…and its schedule and hours are unconfirmed', kinds(label), ['market_label!', 'days_not_confirmed', 'hours_not_confirmed'])
eq('…sold amount unknown, not $0', label.request.soldAmount, null)
const town = buildRequest([hold({ market: 'Smallville', state: 'KS', standard_market_uid: null })], linked, unsent)!
eq('a town off LED\'s list blocks and is sent by name', [kinds(town), town.request.markets[0].otherMarketName], [['no_standard_market!'], 'Smallville, KS'])
eq('won without a job number blocks', kinds(buildRequest([hold({ status: 'COMMITTED' })], linked, unsent)), ['no_job_number!'])
eq('the placeholder job number counts as none', kinds(buildRequest([hold({ status: 'COMMITTED', sfdc_job_number: '00-0000-000' })], linked, unsent)), ['no_job_number!'])
eq('any all-zero placeholder counts as none', kinds(buildRequest([hold({ status: 'COMMITTED', sfdc_job_number: '00-0000-0000' })], linked, unsent)), ['no_job_number!'])
const won = buildRequest([hold({ status: 'COMMITTED', sfdc_job_number: ' 26-1234-001 ' })], linked, unsent)!
eq('won with a job number: sent trimmed, nothing for ops', [won.request.jobNumber, won.issues], ['26-1234-001', []])

section('buildRequests: bookings')
const all = buildRequests([
  hold({ campaign_group_id: 'cg_a' }), hold({ campaign_group_id: 'cg_a', truck_number: '0202' }),
  hold({ campaign_group_id: 'cg_b' }),
  hold({ campaign_group_id: 'cg_c', status: 'EXPIRED' }),
], linked, unsent)
eq('one request per live booking; an expired one is left out', all.map(r => r.request.externalRef), ['cg_a', 'cg_b'])
eq('an expired hold isn\'t sent with live ones', buildRequest([hold(), hold({ truck_number: '0202', status: 'EXPIRED' })], linked, unsent)!.request.markets[0].trucks, ['0101'])

section('requestFingerprint')
eq('same request, same fingerprint', requestFingerprint(one.request) === requestFingerprint(buildRequest([hold(), hold({ truck_number: '0099' })], linked, unsent)!.request), true)
eq('a changed truck changes it', requestFingerprint(one.request) === requestFingerprint(buildRequest([hold(), hold({ truck_number: '0098' })], linked, unsent)!.request), false)

section('buildRequest: hours that are not an LED shift length')
const eleven = buildRequest([hold({ features: JSON.stringify({ daysPerWeek: 5, operatingHours: 11 }) })], linked, unsent)!
eq('11 hours: the 12-hour shift, flagged for ops', [eleven.request.markets[0].duration, eleven.issues.map(i => i.kind)], ['TWELVE_HOUR_SHIFT', ['hours_rounded']])
eq('14 hours: not a shift; 8 hours sent and flagged off-shift', buildRequest([hold({ features: JSON.stringify({ daysPerWeek: 5, operatingHours: 14 }) })], linked, unsent)!.issues.map(i => i.kind), ['hours_off_shift'])
eq('mixed hours: the shift sent is the one judged for rounding', buildRequest([hold({ features: JSON.stringify({ daysPerWeek: 5, operatingHours: 9 }) }), hold({ truck_number: '0202', features: JSON.stringify({ daysPerWeek: 5, operatingHours: 8 }) })], linked, unsent)!.issues.map(i => i.kind), ['hours_rounded'])
const mixed = buildRequest([hold({ features: JSON.stringify({ daysPerWeek: 5, operatingHours: 8 }) }), hold({ truck_number: '0202', features: JSON.stringify({ daysPerWeek: 5, operatingHours: 12 }) })], linked, unsent)!
eq('mixed 8 and 12 hours: the 12-hour shift covers both, flagged', [mixed.request.markets[0].duration, mixed.issues.map(i => i.kind)], ['TWELVE_HOUR_SHIFT', ['hours_rounded']])

section('buildRequest: a hold the sweep has not located yet')
const unswept = buildRequest([hold(), hold({ truck_number: '0202', standard_market_uid: null })], linked, unsent)!
eq('stays in its booking\'s located market, not split off and blocked', [unswept.request.markets.map(m => [m.standardMarketUid, m.trucks]), unswept.issues], [[[DALLAS, ['0101', '0202']]], []])

section('buildRequest: stale asked-for dates')
const moved = buildRequest([hold({ start_date: '2027-01-04', end_date: '2027-01-17', features: JSON.stringify({ daysPerWeek: 5, operatingHours: 8, requestedStart: '2026-12-07', requestedEnd: '2026-12-20' }) })], linked, unsent)!
eq('holds re-dated after the quote: the holds\' dates are sent', [moved.request.markets[0].startDate, moved.request.markets[0].endDate], ['2027-01-04', '2027-01-17'])

section('buildRequest: sold amount groups as the Reservations card does')
eq('holds with no campaign group share one price', buildRequest([hold({ campaign_group_id: null }), hold({ campaign_group_id: null, truck_number: '0202' })], linked, unsent)!.request.soldAmount, 20000)

section('buildRequest: mixed schedules, no trucks, and when a booking leaves the list')
const mixedDays = buildRequest([hold({ campaign_group_id: null }), hold({ campaign_group_id: null, truck_number: '0202', features: JSON.stringify({ daysPerWeek: 7, operatingHours: 10 }) })], linked, unsent)!
eq('5 and 7 days in one market: every day sent, flagged', [on(mixedDays.request.markets[0].days), kinds(mixedDays)], ['sun mon tue wed thu fri sat', ['days_not_confirmed']])
eq('a market with no real truck blocks', kinds(buildRequest([hold({ truck_number: '' })], linked, unsent)), ['no_trucks!'])
eq('holdsEnd counts travel days past the asked-for end', buildRequest([hold({ end_date: '2026-12-22', features: JSON.stringify({ daysPerWeek: 5, operatingHours: 10, requestedStart: '2026-12-07', requestedEnd: '2026-12-20' }) })], linked, unsent)!.holdsEnd, '2026-12-22')

section('a revised booking keeps its request')
// A revise replaces the holds under a new key (mm_<requestId>); Core must be
// sent the ref it was first sent, or it opens a second request.
const sentAs = (key: string) => (key === 'mm_r2' ? 'cg_1' : null)
const revised = buildRequest([hold({ campaign_group_id: 'mm_r2_1' })], linked, sentAs)!
eq('the booking\'s key is the new one', revised.bookingKey, 'mm_r2')
eq('Core is sent the ref it was first sent', revised.request.externalRef, 'cg_1')
eq('never sent: its key is the ref', buildRequest([hold({ campaign_group_id: 'mm_r3_1' })], linked, sentAs)!.request.externalRef, 'mm_r3')
const holdRoute = readFileSync(join(process.cwd(), 'app/api/plan/hold/route.ts'), 'utf8')
const writeAll = holdRoute.slice(holdRoute.indexOf('const writeAll = async'), holdRoute.indexOf('const writeAll = async') + 2000)
eq('the revise renames its request row in the same transaction as the holds; a quote-only one leaves it to be declined',
  /if \(reviseKey && !quoteOnly\) await tx\.campaignRequestSync\.updateMany\(\{ where: \{ booking_key: reviseKey \}, data: \{ booking_key: newKey \} \}\)/.test(writeAll), true)

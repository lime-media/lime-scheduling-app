/**
 * Won reservations ↔ their LED program, linked by job number (lib/ledJobs.ts):
 * the match Reservations hides scheduled bookings by, and the conflict sweep's
 * rule that a booking's own program isn't a clash with it.
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { daysSold, ledMarketMatches, ledStandings, type JobHold } from '@/lib/ledJobs'
import { isOwnLedProgram, jobKey, linkedJob, realJobNumber } from '@/lib/jobNumber'
import { fieldUnreadable } from '@/lib/salesforceClient'
import { bookingInLed, ledProgress } from '@/lib/bookings'
import { findConflicts, type ConflictHold, type ConflictSchedule } from '@/lib/scheduleCache'
import { dropOwnProgramDays, groupDaysIntoJobs } from '@/lib/truckTimeline'

const h = (over: Partial<JobHold> = {}): JobHold => ({
  id: 'h1', truck_number: '6907', start_date: '2026-10-30', end_date: '2026-11-01', job_number: '26-0439-300', days_sold: 3, ...over,
})
const shift = (truck_number: string, job_number: string, shift_date: string) => ({ truck_number, job_number, shift_date })

section('realJobNumber')
eq('a real job number', realJobNumber(' 26-0439-300 '), '26-0439-300')
eq('the 00-0000-000 placeholder is none', realJobNumber('00-0000-000'), null)
eq('blank is none', realJobNumber(''), null)

section('daysSold')
eq('the quote\'s activation days (6 days a week over 56)', daysSold(JSON.stringify({ activationDays: 48 }), '2026-10-19', '2026-12-13'), 48)
eq('no quote on file: every calendar day', daysSold(null, '2026-10-30', '2026-11-01'), 3)
eq('unreadable features: every calendar day', daysSold('{oops', '2026-10-30', '2026-11-01'), 3)
eq('never more than the span', daysSold(JSON.stringify({ activationDays: 9 }), '2026-10-30', '2026-11-01'), 3)
eq('a rotating stint sells its own work days, not the line\'s span', daysSold(JSON.stringify({ activationDays: 12, calendarDays: 28, heldStart: '2026-10-16', heldEnd: '2026-10-22', heldWorkDays: 6 }), '2026-10-16', '2026-10-22'), 6)
eq('a stint re-dated after it was written: every calendar day', daysSold(JSON.stringify({ calendarDays: 28, heldStart: '2026-10-16', heldEnd: '2026-10-22', heldWorkDays: 6 }), '2026-10-16', '2026-10-25'), 10)
eq('re-dated after the quote: every calendar day', daysSold(JSON.stringify({ activationDays: 12, calendarDays: 14 }), '2026-10-19', '2026-11-15'), 28)
eq('quoted for these dates: the activation days', daysSold(JSON.stringify({ activationDays: 12, calendarDays: 14 }), '2026-10-19', '2026-11-01'), 12)

section('ledStandings')
const run = (truck: string, job: string, days: string[]) => days.map(d => shift(truck, job, d))
const all3 = run('6907', '26-0439-300', ['2026-10-30', '2026-10-31', '2026-11-01'])
eq('every sold day on its truck: scheduled', ledStandings([h()], all3).get('h1'), { days: 3, of: 3, scheduled: true })
eq('a day short: not scheduled, shows the shortfall', ledStandings([h()], all3.slice(0, 2)).get('h1'), { days: 2, of: 3, scheduled: false })
eq('one day of a 30-day booking is not enough', ledStandings([h({ end_date: '2026-11-28', days_sold: 30 })], all3.slice(0, 1)).get('h1')?.scheduled, false)
eq('6 days a week: the sold days are enough', ledStandings([h({ start_date: '2026-11-02', end_date: '2026-11-08', days_sold: 6 })],
  run('6907', '26-0439-300', ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'])).get('h1')?.scheduled, true)
eq('nothing sold (bad dates) is never scheduled', ledStandings([h({ days_sold: 0 })], []).get('h1')?.scheduled, false)
eq('a day counts once however many shifts', ledStandings([h()], [...all3, ...all3]).get('h1')?.days, 3)
eq('its job on another truck does not count', ledStandings([h()], run('1261', '26-0439-300', ['2026-10-30', '2026-10-31', '2026-11-01'])).get('h1')?.days, 0)
eq('another job on its truck does not count', ledStandings([h()], run('6907', '26-0387-300', ['2026-10-30', '2026-10-31', '2026-11-01'])).get('h1')?.days, 0)
eq('days outside its dates do not count', ledStandings([h()], run('6907', '26-0439-300', ['2026-10-29', '2026-11-02'])).get('h1')?.days, 0)
eq('a placeholder job never matches', ledStandings([h({ job_number: '00-0000-000' })], run('6907', '00-0000-000', ['2026-10-30'])).has('h1'), false)
eq('no job number on the hold never matches', ledStandings([h({ job_number: null })], all3).has('h1'), false)

section('bookingInLed / ledProgress')
const won = (led_scheduled: boolean) => ({ status: 'COMMITTED', led_scheduled })
eq('every committed hold scheduled: in LED', bookingInLed([won(true), won(true)]), true)
eq('one not scheduled: still listed', bookingInLed([won(true), won(false)]), false)
eq('a live reservation in it: still listed', bookingInLed([won(true), { status: 'HOLD', led_scheduled: false }]), false)
eq('expired parts are ignored', bookingInLed([won(true), { status: 'EXPIRED', led_scheduled: false }]), true)
eq('nothing live: not in LED', bookingInLed([{ status: 'EXPIRED', led_scheduled: false }]), false)
eq('progress sums committed truck-days', ledProgress([
  { status: 'COMMITTED', led_days: 3, led_days_sold: 3 },
  { status: 'COMMITTED', led_days: 1, led_days_sold: 6 },
  { status: 'HOLD', led_days: 0, led_days_sold: null },
]), { days: 4, of: 9, known: true })
eq('extra LED days don\'t cover another truck\'s shortfall', ledProgress([
  { status: 'COMMITTED', led_days: 5, led_days_sold: 3 },
  { status: 'COMMITTED', led_days: 0, led_days_sold: 3 },
]), { days: 3, of: 6, known: true })
eq('a committed hold with no job number: not known', ledProgress([{ status: 'COMMITTED', led_days: 0, led_days_sold: null }])?.known, false)
eq('a hold with no job number doesn\'t hide the others\' progress', ledProgress([
  { status: 'COMMITTED', led_days: 2, led_days_sold: 2 },
  { status: 'COMMITTED', led_days: 0, led_days_sold: null },
]), { days: 2, of: 2, known: true })
eq('no committed holds: no progress', ledProgress([{ status: 'HOLD' }]), null)

section('findConflicts: a booking against its own LED program')
const ch = (over: Partial<ConflictHold> = {}): ConflictHold => ({
  id: 'h1', truck_number: '6907', client_name: 'Firefly', market: 'Phoenix, AZ', source: 'INTERNAL',
  start_date: '2026-10-30', end_date: '2026-11-01', job_number: '26-0439-300', ...over,
})
const block = (over: Partial<ConflictSchedule> = {}): ConflictSchedule => ({
  truck_number: '6907', program: 'PHX', market: 'Phoenix', shift_start: '2026-10-30', shift_end: '2026-10-30', job_number: '26-0439-300', ...over,
})
eq('its own job is not a conflict', findConflicts([block()], [ch()]).length, 0)
eq('another job on the truck still is', findConflicts([block({ program: 'ATT FIBER', job_number: '26-0387-300' })], [ch()]).length, 1)
eq('maintenance (placeholder job) still is', findConflicts([block({ program: 'Truck Maintenance', job_number: '00-0000-000' })], [ch({ job_number: '00-0000-000' })]).length, 1)
eq('a hold with no job number conflicts as before', findConflicts([block()], [ch({ job_number: null })]).length, 1)
eq('own job skipped, other program on the same days kept', findConflicts([block(), block({ program: 'ATT FIBER', job_number: '26-0387-300' })], [ch()]).map(c => c.program), ['ATT FIBER'])
eq('a same-named program with another job still conflicts', findConflicts([block(), block({ shift_start: '2026-10-31', shift_end: '2026-10-31', job_number: '26-0387-300' })], [ch()]).length, 1)

section('truck timelines carry the job number (the infeasible audit skips a won hold\'s own program)')
const day = (date: string, jobNumber: string) => ({ truckNumber: '6907', date, market: 'Phoenix', state: 'AZ', program: 'PHX', jobNumber })
const tl = groupDaysIntoJobs([day('2026-10-30', '26-0439-300'), day('2026-10-31', '26-0439-300')]).get('6907') ?? []
eq('one job, its job number kept', tl.map(j => [j.start, j.end, j.jobNumber]), [['2026-10-30', '2026-10-31', '26-0439-300']])
eq('same program name, different job: two jobs', (groupDaysIntoJobs([day('2026-10-30', '26-0439-300'), day('2026-10-31', '26-0387-300')]).get('6907') ?? []).length, 2)

section('Salesforce: an unreadable Job_Number__c only drops the LED link')
// Salesforce's INVALID_FIELD message repeats the whole query, so every one mentions Job_Number__c.
const invalid = (col: string) => new Error(`Salesforce SOQL query failed — INVALID_FIELD: \nSELECT Id, StageName, IsClosed, IsWon, Amount, Job_Number__c FROM Opportunity\n ^\nERROR at Row:1:Column:44\nNo such column '${col}' on entity 'Opportunity'. If you are attempting to use a custom field, be sure to append the '__c' after the custom field name.`)
eq('Job_Number__c refused: that field', fieldUnreadable(invalid('Job_Number__c'), 'Job_Number__c'), true)
eq('Amount refused (query still names Job_Number__c): not that field', fieldUnreadable(invalid('Amount'), 'Job_Number__c'), false)
eq('an outage is not', fieldUnreadable(new Error('Salesforce SOQL query failed — HTTP 503'), 'Job_Number__c'), false)

section('job numbers match whatever their case')
eq('jobKey folds case', jobKey(' 26-0439-300a '), '26-0439-300A')
eq('jobKey: placeholder is none', jobKey('00-0000-000'), null)
eq('standings match across case', ledStandings([h({ job_number: '26-0439-300a' })], [shift('6907', '26-0439-300A', '2026-10-30')]).get('h1')?.days, 1)

section('isOwnLedProgram: a won hold\'s own program, within its dates')
const wonHold = { start_date: '2026-10-01', end_date: '2026-10-10', job_number: '26-0500-300' }
eq('its job within its dates', isOwnLedProgram(wonHold, { start: '2026-10-05', end: '2026-10-05', job_number: '26-0500-300' }), true)
eq('its job, case differs', isOwnLedProgram(wonHold, { start: '2026-10-05', end: '2026-10-05', job_number: '26-0500-300'.toLowerCase() }), true)
eq('a block overlapping its dates', isOwnLedProgram(wonHold, { start: '2026-09-28', end: '2026-10-02', job_number: '26-0500-300' }), true)
eq('its job on other dates (another market of the booking) is other work', isOwnLedProgram(wonHold, { start: '2026-10-12', end: '2026-10-20', job_number: '26-0500-300' }), false)
eq('another job is not', isOwnLedProgram(wonHold, { start: '2026-10-05', end: '2026-10-05', job_number: '26-0387-300' }), false)
eq('no job on the hold: never', isOwnLedProgram({ ...wonHold, job_number: null }, { start: '2026-10-05', end: '2026-10-05', job_number: '' }), false)
eq('placeholder jobs never link', isOwnLedProgram({ ...wonHold, job_number: '00-0000-000' }, { start: '2026-10-05', end: '2026-10-05', job_number: '00-0000-000' }), false)

section('linkedJob: only a won hold links to LED')
eq('committed', linkedJob({ status: 'COMMITTED', sfdc_job_number: '26-0500-300' }), '26-0500-300')
eq('a reservation with a job number does not', linkedJob({ status: 'HOLD', sfdc_job_number: '26-0500-300' }), null)
eq('a reopened deal (back to HOLD) does not', linkedJob({ status: 'EXTENSION_REQUESTED', sfdc_job_number: '26-0500-300' }), null)


section('dropOwnProgramDays: a won hold\'s own program days, and only those, leave the timeline')
const dday = (date: string, jobNumber: string, truckNumber = '6907') => ({ truckNumber, date, market: 'Phoenix', state: 'AZ', program: 'PHX', jobNumber })
const wonPhx = { truck_number: '6907', start_date: '2026-10-01', end_date: '2026-10-10', job_number: '26-0439-300' }
const straddle = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'].map(d => dday(d, '26-0439-300'))
eq('a block running past the hold keeps its days after the hold', dropOwnProgramDays(straddle, [wonPhx]).map(d => d.date), ['2026-10-11', '2026-10-12'])
eq('the kept tail is still a job on the timeline', (groupDaysIntoJobs(dropOwnProgramDays(straddle, [wonPhx])).get('6907') ?? []).map(j => [j.start, j.end]), [['2026-10-11', '2026-10-12']])
eq('another truck\'s days of the job stay (a separate hold covers those)', dropOwnProgramDays([dday('2026-10-05', '26-0439-300', '1261')], [wonPhx]).length, 1)
eq('another job on the hold\'s truck stays', dropOwnProgramDays([dday('2026-10-05', '26-0387-300')], [wonPhx]).length, 1)
eq('a hold with no linked job drops nothing', dropOwnProgramDays(straddle, [{ ...wonPhx, job_number: null }]).length, 5)

section('multi-market bookings share a job number: another state is another market')
eq('same job, same dates, another state: not its own', isOwnLedProgram({ ...wonHold, state: 'IA' }, { start: '2026-10-05', end: '2026-10-05', job_number: '26-0500-300', state: 'CO' }), false)
eq('same job, same state: its own', isOwnLedProgram({ ...wonHold, state: 'KS' }, { start: '2026-10-05', end: '2026-10-05', job_number: '26-0500-300', state: 'ks' }), true)
eq('state unknown on one side: job and dates decide', isOwnLedProgram({ ...wonHold, state: 'KS' }, { start: '2026-10-05', end: '2026-10-05', job_number: '26-0500-300', state: '' }), true)
eq('a sibling market\'s days on the hold\'s truck stay on the timeline', dropOwnProgramDays([{ ...dday('2026-10-05', '26-0439-300'), state: 'NM' }], [{ ...wonPhx, state: 'AZ' }]).length, 1)

section('ledMarketMatches (swap picker, another truck): confirmed or the truck stays taken')
eq('same city and state', ledMarketMatches({ market: 'Phoenix, AZ', state: 'AZ' }, { market: 'Phoenix', state: 'AZ', standard_market_name: 'Phoenix, AZ' }), true)
eq('by the standard market', ledMarketMatches({ market: 'Cedar Rapids, IA', state: 'IA' }, { market: 'Cedar Rapids Downtown', state: 'IA', standard_market_name: 'Cedar Rapids, IA' }), true)
eq('a sibling market in the same state', ledMarketMatches({ market: 'Wichita, KS', state: 'KS' }, { market: 'Lawrence', state: 'KS', standard_market_name: 'Kansas City, MO' }), false)
eq('a misspelt city can\'t be confirmed: taken', ledMarketMatches({ market: 'Manhattan, KS', state: 'KS' }, { market: 'Manhatten', state: 'KS', standard_market_name: 'Kansas City, MO' }), false)
eq('another state', ledMarketMatches({ market: 'Phoenix, AZ', state: 'AZ' }, { market: 'Phoenix', state: 'NM' }), false)

/**
 * Won reservations ↔ their LED program, linked by job number (lib/ledJobs.ts):
 * the match Reservations hides scheduled bookings by, and the conflict sweep's
 * rule that a booking's own program isn't a clash with it.
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { daysSold, ledStandings, type JobHold } from '@/lib/ledJobs'
import { realJobNumber } from '@/lib/jobNumber'
import { bookingInLed, ledProgress } from '@/lib/bookings'
import { findConflicts, type ConflictHold, type ConflictSchedule } from '@/lib/scheduleCache'

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

section('ledStandings')
const run = (truck: string, job: string, days: string[]) => days.map(d => shift(truck, job, d))
const all3 = run('6907', '26-0439-300', ['2026-10-30', '2026-10-31', '2026-11-01'])
eq('every sold day on its truck: scheduled', ledStandings([h()], all3).get('h1'), { days: 3, of: 3, scheduled: true })
eq('a day short: not scheduled, shows the shortfall', ledStandings([h()], all3.slice(0, 2)).get('h1'), { days: 2, of: 3, scheduled: false })
eq('one day of a 30-day booking is not enough', ledStandings([h({ end_date: '2026-11-28', days_sold: 30 })], all3.slice(0, 1)).get('h1')?.scheduled, false)
eq('6 days a week: the sold days are enough', ledStandings([h({ start_date: '2026-11-02', end_date: '2026-11-08', days_sold: 6 })],
  run('6907', '26-0439-300', ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'])).get('h1')?.scheduled, true)
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

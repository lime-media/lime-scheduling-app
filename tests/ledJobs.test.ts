/**
 * Won reservations ↔ their LED program, linked by job number (lib/ledJobs.ts):
 * the match Reservations hides scheduled bookings by, and the conflict sweep's
 * rule that a booking's own program isn't a clash with it.
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { ledScheduledHoldIds, type JobHold } from '@/lib/ledJobs'
import { realJobNumber } from '@/lib/jobNumber'
import { bookingInLed, ledProgress } from '@/lib/bookings'
import { findConflicts, type ConflictHold, type ConflictSchedule } from '@/lib/scheduleCache'

const h = (over: Partial<JobHold> = {}): JobHold => ({
  id: 'h1', truck_number: '6907', start_date: '2026-10-30', end_date: '2026-11-01', job_number: '26-0439-300', ...over,
})
const shift = (truck_number: string, job_number: string, shift_date: string) => ({ truck_number, job_number, shift_date })

section('realJobNumber')
eq('a real job number', realJobNumber(' 26-0439-300 '), '26-0439-300')
eq('the 00-0000-000 placeholder is none', realJobNumber('00-0000-000'), null)
eq('blank is none', realJobNumber(''), null)

section('ledScheduledHoldIds')
eq('its job on its truck within its dates', [...ledScheduledHoldIds([h()], [shift('6907', '26-0439-300', '2026-10-31')])], ['h1'])
eq('one day is enough (LED schedules working days only)', [...ledScheduledHoldIds([h({ end_date: '2026-11-30' })], [shift('6907', '26-0439-300', '2026-11-03')])], ['h1'])
eq('its job on another truck is not this hold scheduled', [...ledScheduledHoldIds([h()], [shift('1261', '26-0439-300', '2026-10-31')])], [])
eq('another job on its truck is not this hold scheduled', [...ledScheduledHoldIds([h()], [shift('6907', '26-0387-300', '2026-10-31')])], [])
eq('its job on its truck outside its dates is not', [...ledScheduledHoldIds([h()], [shift('6907', '26-0439-300', '2026-11-02')])], [])
eq('a placeholder job never matches', [...ledScheduledHoldIds([h({ job_number: '00-0000-000' })], [shift('6907', '00-0000-000', '2026-10-31')])], [])
eq('no job number on the hold never matches', [...ledScheduledHoldIds([h({ job_number: null })], [shift('6907', '26-0439-300', '2026-10-31')])], [])

section('bookingInLed / ledProgress')
const won = (led_scheduled: boolean) => ({ status: 'COMMITTED', led_scheduled })
eq('every committed hold scheduled: in LED', bookingInLed([won(true), won(true)]), true)
eq('one not scheduled: still listed', bookingInLed([won(true), won(false)]), false)
eq('a live reservation in it: still listed', bookingInLed([won(true), { status: 'HOLD', led_scheduled: false }]), false)
eq('expired parts are ignored', bookingInLed([won(true), { status: 'EXPIRED', led_scheduled: false }]), true)
eq('nothing live: not in LED', bookingInLed([{ status: 'EXPIRED', led_scheduled: false }]), false)
eq('progress counts committed holds', ledProgress([won(true), won(false), { status: 'HOLD', led_scheduled: false }]), { scheduled: 1, of: 2 })
eq('no committed holds: no progress', ledProgress([{ status: 'HOLD', led_scheduled: false }]), null)

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

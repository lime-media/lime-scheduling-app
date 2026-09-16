/**
 * Conflict identity — which (hold × LED schedule block) overlaps exist in the
 * current data, and what key each one is recorded under.
 *
 * This is the shared definition behind both conflict passes: detectConflicts()
 * inserts what findConflicts() returns and the table lacks, and
 * reconcileConflicts() resolves what the table holds and findConflicts() no
 * longer returns. The cases below are the edits that used to strand an ACTIVE
 * conflict row forever — a truck swap, a re-date, a cancelled program.
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { findConflicts, type ConflictHold, type ConflictSchedule } from '@/lib/scheduleCache'

function hold(over: Partial<ConflictHold> = {}): ConflictHold {
  return {
    id:           'hold_1',
    truck_number: '1488',
    client_name:  'Firefly',
    market:       'Charlotte, NC',
    source:       'CLIENT',
    start_date:   '2026-09-18',
    end_date:     '2026-09-20',
    ...over,
  }
}

function shift(over: Partial<ConflictSchedule> = {}): ConflictSchedule {
  return {
    truck_number: '1488',
    program:      'ATT FIBER',
    market:       'Raleigh, NC',
    shift_start:  '2026-09-19',
    shift_end:    '2026-09-22',
    ...over,
  }
}

const keys = (s: ConflictSchedule[], h: ConflictHold[]) => findConflicts(s, h).map((c) => c.key)

section('Conflict detection')

eq('overlapping hold and shift conflict', keys([shift()], [hold()]).length, 1)
eq('window is clamped to the intersection',
  findConflicts([shift()], [hold()]).map((c) => [c.conflictStart, c.conflictEnd]),
  [['2026-09-19', '2026-09-20']])
eq('a different truck is not a conflict',   keys([shift({ truck_number: '4322' })], [hold()]), [])
eq('a shift ending before the hold starts', keys([shift({ shift_start: '2026-09-10', shift_end: '2026-09-17' })], [hold()]), [])
eq('a shift starting after the hold ends',  keys([shift({ shift_start: '2026-09-21', shift_end: '2026-09-25' })], [hold()]), [])
eq('touching at a single day still conflicts',
  keys([shift({ shift_start: '2026-09-20', shift_end: '2026-09-25' })], [hold()]).length, 1)
eq('two overlapping shifts raise two conflicts',
  keys([shift(), shift({ program: 'TOYOTA', shift_start: '2026-09-18', shift_end: '2026-09-18' })], [hold()]).length, 2)

section('Conflict identity across edits')

// Each of these is an edit ops makes on the Reservations page. The old key must disappear from
// the live set, which is what lets reconcileConflicts() close the row it was recorded under.
const original = keys([shift()], [hold()])[0]

eq('swapping the truck changes the key',
  keys([shift()], [hold({ truck_number: '4322' })]).includes(original), false)
eq('re-dating clear of the shift drops the conflict',
  keys([shift()], [hold({ start_date: '2026-09-25', end_date: '2026-09-26' })]), [])
eq('the program moving away drops the conflict',
  keys([shift({ shift_start: '2026-10-01', shift_end: '2026-10-05' })], [hold()]), [])
eq('the program being cancelled drops the conflict', keys([], [hold()]), [])
eq('the hold going away drops the conflict',         keys([shift()], []), [])
eq('an untouched conflict keeps its key',            keys([shift()], [hold()])[0], original)

// Two holds on one truck are distinct conflicts even over an identical window — resolving one
// must not silently resolve the other.
eq('per-hold identity',
  new Set(keys([shift()], [hold(), hold({ id: 'hold_2', client_name: 'Other' })])).size, 2)

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
import { findConflicts, mergeScheduleBlocks, priorDecision, programKey, type ConflictHold, type ConflictSchedule } from '@/lib/scheduleCache'
import { mergeSoftHoldClashes } from '@/lib/attSoftRules'

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

section('Conflicts are date ranges, not days')

// SCHEDULED_QUERY returns one row per scheduled day.
const day = (d: string, over: Partial<ConflictSchedule> = {}) => shift({ shift_start: d, shift_end: d, ...over })
const month = Array.from({ length: 30 }, (_, i) => day(`2026-09-${String(i + 1).padStart(2, '0')}`))
const longHold = hold({ start_date: '2026-09-05', end_date: '2026-09-25' })

eq('30 scheduled days of one program are one block', mergeScheduleBlocks(month).map(b => [b.shift_start, b.shift_end]), [['2026-09-01', '2026-09-30']])
eq('a reservation over them is ONE conflict', findConflicts(month, [longHold]).length, 1)
eq('over the days they overlap',
  findConflicts(month, [longHold]).map(c => [c.conflictStart, c.conflictEnd]), [['2026-09-05', '2026-09-25']])
const gap = [day('2026-09-05'), day('2026-09-06'), day('2026-09-09'), day('2026-09-10')]
eq('a gap in the program starts a new block', findConflicts(gap, [longHold]).map(c => c.conflictStart), ['2026-09-05', '2026-09-09'])
const twoPrograms = [day('2026-09-05'), day('2026-09-06'), day('2026-09-07', { program: 'TOYOTA' }), day('2026-09-08', { program: 'TOYOTA' })]
eq('a different program is its own conflict', findConflicts(twoPrograms, [longHold]).map(c => c.program), ['ATT FIBER', 'TOYOTA'])
eq('other trucks are not merged in',
  mergeScheduleBlocks([day('2026-09-05'), day('2026-09-06', { truck_number: '4322' })]).length, 2)
eq('the input is not changed', month[0].shift_end, '2026-09-01')

section('Earlier rows: dismissed, already shown, or new')

let rid = 0
const row = (start: string, end: string, status = 'ACTIVE', resolved_by: string | null = null) =>
  ({ id: `r${++rid}`, conflict_start: start, conflict_end: end, status, resolved_by })
eq('nothing before: new (emailed)', priorDecision('2026-09-05', '2026-09-25', []), 'new')
eq('still showing (ACTIVE overlaps): recorded, not emailed again',
  priorDecision('2026-09-05', '2026-09-25', [row('2026-09-05', '2026-09-10')]), 'reported')
const rollover = [row('2026-09-05', '2026-09-05', 'RESOLVED'), row('2026-09-06', '2026-09-06', 'RESOLVED')]
eq('one-day rows this sweep just closed (the rollover): not emailed again',
  priorDecision('2026-09-05', '2026-09-25', rollover, new Set(rollover.map(r => r.id))), 'reported')
// Sarah's review: a conflict that went away (closed by an earlier sweep) and came back.
eq('went away and came back: emailed again',
  priorDecision('2026-09-05', '2026-09-25', [row('2026-09-05', '2026-09-25', 'RESOLVED', null)]), 'new')
eq('a person dismissed every day: stays dismissed',
  priorDecision('2026-09-05', '2026-09-07', [row('2026-09-05', '2026-09-06', 'RESOLVED', 'u1'), row('2026-09-07', '2026-09-07', 'RESOLVED', 'u2')]), 'dismissed')
eq('dismissed only some days, rest never shown: new',
  priorDecision('2026-09-05', '2026-09-25', [row('2026-09-05', '2026-09-06', 'RESOLVED', 'u1')]), 'new')
eq('rows for other dates do not count', priorDecision('2026-09-05', '2026-09-07', [row('2026-08-01', '2026-08-03', 'RESOLVED', 'u1')]), 'new')
// Paid review #140: shifts now take their market's local day, so an evening
// program dismissed as Nov 2–6 (its UTC days) is found as Nov 1–5.
const CUT = '2026-10-28T00:00:00.000Z'
const utcRow = (start: string, end: string, detected_at: string) => ({ ...row(start, end, 'RESOLVED', 'u1'), detected_at })
eq('a dismissal recorded with UTC days also covers the day before it',
  priorDecision('2026-11-01', '2026-11-05', [utcRow('2026-11-02', '2026-11-06', '2026-10-20T10:00:00.000Z')], new Set(), CUT), 'dismissed')
eq('not two days before',
  priorDecision('2026-10-31', '2026-11-05', [utcRow('2026-11-02', '2026-11-06', '2026-10-20T10:00:00.000Z')], new Set(), CUT), 'new')
eq('a dismissal recorded with local days covers only its own days',
  priorDecision('2026-11-01', '2026-11-05', [utcRow('2026-11-02', '2026-11-06', '2026-10-29T10:00:00.000Z')], new Set(), CUT), 'new')
eq('no cutoff known: the strict rule',
  priorDecision('2026-11-01', '2026-11-05', [utcRow('2026-11-02', '2026-11-06', '2026-10-20T10:00:00.000Z')]), 'new')

section('Conflict identity includes the program')
// Sarah's review: dismissing reservation R against ATT FIBER must not hide a
// later TOYOTA clash on the same truck and dates. The detection reads prior
// rows for the same program only; the key carries it too.
const fiber = findConflicts([shift({ shift_start: '2026-09-18', shift_end: '2026-09-20' })], [hold()])[0].key
const toyota = findConflicts([shift({ program: 'TOYOTA', shift_start: '2026-09-18', shift_end: '2026-09-20' })], [hold()])[0].key
eq('same reservation, truck and dates, different program: different conflicts', fiber === toyota, false)
eq('a cosmetic difference in the program name is the same conflict',
  findConflicts([shift({ program: '  att  fiber ', shift_start: '2026-09-18', shift_end: '2026-09-20' })], [hold()])[0].key, fiber)
eq('programKey', programKey('  ATT   Fiber '), 'att fiber')

section('AT&T soft-hold clashes: one row per reservation')

const piece = (softHoldId: string, s1: string, e1: string, o1: string, o2: string) =>
  ({ reservationId: 'r1', softHoldId, softHold: { start: s1, end: e1 }, overlap: { start: o1, end: o2 } })
const merged = mergeSoftHoldClashes([piece('oct', '2026-10-01', '2026-10-31', '2026-10-20', '2026-10-31'), piece('nov', '2026-11-01', '2026-11-30', '2026-11-01', '2026-11-08')])
eq('October and November pieces are one row', merged.length, 1)
eq('spanning both', [merged[0].overlap, merged[0].softHold], [{ start: '2026-10-20', end: '2026-11-08' }, { start: '2026-10-01', end: '2026-11-30' }])
eq('with both piece ids (dismiss covers both)', merged[0].softHoldIds, ['oct', 'nov'])
eq('different reservations stay apart',
  mergeSoftHoldClashes([piece('oct', '2026-10-01', '2026-10-31', '2026-10-20', '2026-10-31'), { ...piece('oct', '2026-10-01', '2026-10-31', '2026-10-02', '2026-10-03'), reservationId: 'r2' }]).length, 2)


// Sarah's review: October and December with November released are not one range.
const gapped = mergeSoftHoldClashes([
  piece('oct', '2026-10-01', '2026-10-31', '2026-10-20', '2026-10-31'),
  piece('dec', '2026-12-01', '2026-12-31', '2026-12-01', '2026-12-05'),
])
eq('months with a released month between stay separate rows', gapped.map(g => g.softHoldIds), [['oct'], ['dec']])
eq('and neither claims the released month', gapped.map(g => `${g.softHold.start}..${g.softHold.end}`), ['2026-10-01..2026-10-31', '2026-12-01..2026-12-31'])

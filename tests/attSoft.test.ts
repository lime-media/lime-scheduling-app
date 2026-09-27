/**
 * AT&T soft holds — the pure rules: who counts as AT&T, and the window.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { attLookback, isAttClient, isAttTruck, softHoldWindow } from '@/lib/attSoftRules'

section('AT&T soft holds: who is AT&T')
eq('160over90 is AT&T, whatever the program is called', isAttClient('160over90'), true)
eq('case and spaces do not matter', isAttClient('  160OVER90 '), true)
eq('another client is not', isAttClient('Lime Media Testing'), false)
eq('no client is not', isAttClient(null), false)

section('AT&T soft holds: current month plus the next two')
eq('from Sep 27: rest of September, all of October and November', softHoldWindow('2026-09-27').map(w => [w.start, w.end]), [
  ['2026-09-27', '2026-09-30'],
  ['2026-10-01', '2026-10-31'],
  ['2026-11-01', '2026-11-30'],
])
eq('across a year end', softHoldWindow('2026-12-15').map(w => [w.start, w.end]), [
  ['2026-12-15', '2026-12-31'],
  ['2027-01-01', '2027-01-31'],
  ['2027-02-01', '2027-02-28'],
])
eq('labels', softHoldWindow('2026-09-27').map(w => w.label), ['September 2026', 'October 2026', 'November 2026'])

section('AT&T soft holds: which trucks are AT&T\'s')
eq('counts the prior month and the current month', attLookback('2026-09-27'), { from: '2026-08-01', to: '2026-09-30' })
eq('across a year start', attLookback('2027-01-10'), { from: '2026-12-01', to: '2027-01-31' })
eq('more than 5 days for 160over90: AT&T', isAttTruck(6), true)
eq('exactly 5 is not enough', isAttTruck(5), false)
eq('a truck that did 20 AT&T days and then 2 days elsewhere keeps its soft hold', isAttTruck(20), true)

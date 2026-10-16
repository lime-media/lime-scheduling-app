/**
 * Other dates for a quote with too few trucks (lib/quoteAlternatives.ts).
 * Built on the Raleigh, Nov 2–18 case of 2026-10-15.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { getMarketCoords } from '@/lib/marketCoordinates'
import { dateOptions, daysShorter, fitsWindow, insufficientSummary, windowAlternatives } from '@/lib/quoteAlternatives'
import type { TruckJob } from '@/lib/truckTimeline'

const C = (m: string) => getMarketCoords(m)!
const raleigh = C('Raleigh, NC')
const job = (start: string, end: string, market: string, state: string, opts: Partial<TruckJob> = {}): TruckJob =>
  ({ start, end, market, state, source: 'HOLD', status: 'HOLD', yieldable: false, ...opts })
const base = { campaignCoords: raleigh, currentCoords: C('Dallas, TX'), today: '2026-10-15', start: '2026-11-02', end: '2026-11-18' }

section('quote alternatives: a later start')
// Like trucks 0758/0768: reserved in Colorado Springs Oct 29–30, ~1,500 mi from Raleigh.
const colorado = [job('2026-10-29', '2026-10-30', 'Denver', 'CO')]
eq('cannot take Nov 2', fitsWindow({ ...base, jobs: colorado }), false)
const alt = windowAlternatives({ ...base, jobs: colorado })
eq('earliest start is after the travel days', alt.earliestStart, '2026-11-04')
eq('ending earlier does not help an arrival problem', alt.latestEnd, undefined)
eq('and that start does work', fitsWindow({ ...base, jobs: colorado, start: '2026-11-04' }), true)

section('quote alternatives: an earlier end')
// Free for the dates, but booked in Chicago from Nov 19 (~640 mi, 2 travel days).
const chicago = [job('2026-11-19', '2026-11-25', 'Chicago', 'IL')]
const altEnd = windowAlternatives({ ...base, jobs: chicago, currentCoords: raleigh })
eq('latest end leaves the travel days', altEnd.latestEnd, '2026-11-16')
eq('a later start does not help a next-job problem', altEnd.earliestStart, undefined)

section('quote alternatives: AT&T soft hold resuming after the booking')
// Like truck 6499: its soft hold resumes in Columbus, GA the day after.
const att = [job('2026-11-19', '2026-11-30', 'Columbus', 'GA', { status: 'ATT_SOFT', yieldable: true })]
eq('clients: still blocked', fitsWindow({ ...base, jobs: att, currentCoords: raleigh }), false)
eq('staff: allowed (with a warning in the quote)', fitsWindow({ ...base, jobs: att, currentCoords: raleigh, softHoldStrandIsWarning: true }), true)

section('quote alternatives: suggesting dates')
const alts = [{ earliestStart: '2026-11-04' }, { earliestStart: '2026-11-03' }, { earliestStart: '2026-11-04' }, { latestEnd: '2026-11-16' }]
eq('one truck needed: the earliest start that gives one', dateOptions({ freeNow: 0, needed: 1, alternatives: alts }).startFrom, { date: '2026-11-03', trucks: 1 })
eq('three needed: a later start, counting all that fit by then', dateOptions({ freeNow: 0, needed: 3, alternatives: alts }).startFrom, { date: '2026-11-04', trucks: 3 })
eq('end option', dateOptions({ freeNow: 0, needed: 1, alternatives: alts }).endBy, { date: '2026-11-16', trucks: 1 })
eq('not enough either way: no option', dateOptions({ freeNow: 0, needed: 5, alternatives: alts }), {})
eq('trucks free now count too', dateOptions({ freeNow: 2, needed: 3, alternatives: alts }).startFrom, { date: '2026-11-03', trucks: 3 })

section('quote alternatives: what the rep reads')
const s = insufficientSummary({ market: 'Raleigh, NC', start: '2026-11-02', end: '2026-11-18', requested: 1, free: 0, releasable: 31,
  options: { startFrom: { date: '2026-11-04', trucks: 4 } } })
eq('headline states the fact', s.message, 'No truck is free and able to reach Raleigh, NC for Nov 2 – Nov 18.')
eq('detail gives the ways forward, with what each costs', s.detail, 'To book it: release the AT&T soft hold on 1 truck (31 held for AT&T to choose from, below), or start Nov 4 instead (4 trucks, 2 days shorter).')
eq('partial supply', insufficientSummary({ market: 'Raleigh, NC', start: '2026-11-02', end: '2026-11-18', requested: 3, free: 1, releasable: 0, options: {} }).message,
  'Only 1 of 3 trucks is free and able to reach Raleigh, NC for Nov 2 – Nov 18.')
eq('nothing works: says so', insufficientSummary({ market: 'Raleigh, NC', start: '2026-11-02', end: '2026-11-18', requested: 1, free: 0, releasable: 0, options: {} }).detail,
  'No date within 14 days either way frees enough trucks. Price it as a quote only, or ask operations.')
eq('ending earlier is shorter too', daysShorter({ start: '2026-11-02', end: '2026-11-18' }, { endBy: '2026-11-16' }), 2)
eq('so is starting later', daysShorter({ start: '2026-11-02', end: '2026-11-18' }, { startFrom: '2026-11-04' }), 2)
eq('releases needed, not soft holds nearby',
  insufficientSummary({ market: 'Raleigh, NC', start: '2026-11-02', end: '2026-11-18', requested: 3, free: 1, releasable: 2, options: {} }).detail,
  'To book it: release the AT&T soft hold on 2 trucks (below).')


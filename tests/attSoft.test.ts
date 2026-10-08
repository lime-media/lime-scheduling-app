/**
 * AT&T soft holds — the pure rules: who counts as AT&T, and the window.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { attLookback, carve, freeRanges, isAttClient, isAttTruck, planMarketBackfill, planReleaseCuts, planSoftHoldFill, reinstateBlockedByRelease, releaseBlockedReason, rosterPlan, validateRosterOverride, softHoldWindow, softHoldYieldsOn, validateReleaseRange, ATT_RELEASE_WARNING, ATT_RELEASE_MAX_DAYS } from '@/lib/attSoftRules'
import { clientBookingRefusal, partnerClashDetail, staffBookingRefusal } from '@/lib/bookingRefusals'

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
{
  const early = attLookback('2026-10-10')
  const late = attLookback('2026-10-11')
  eq('through the 10th: the prior month counts too', early, { current: { from: '2026-10-01', to: '2026-10-31' }, prior: { from: '2026-09-01', to: '2026-09-30' } })
  eq('from the 11th: the current month only', late, { current: { from: '2026-10-01', to: '2026-10-31' }, prior: null })
  eq('across a year start', attLookback('2027-01-03').prior, { from: '2026-12-01', to: '2026-12-31' })
  eq('more than 5 days this month: AT&T', isAttTruck({ current: 6, prior: 0 }, late), true)
  eq('exactly 5 is not enough', isAttTruck({ current: 5, prior: 0 }, late), false)
  eq('months are not added together (3 + 3)', isAttTruck({ current: 3, prior: 3 }, early), false)
  eq('early in the month, last month alone is enough', isAttTruck({ current: 0, prior: 20 }, early), true)
  eq('after the 10th, no 160over90 shifts this month: released', isAttTruck({ current: 0, prior: 20 }, late), false)
  eq('a truck on AT&T all month with 2 days elsewhere keeps it', isAttTruck({ current: 18, prior: 0 }, late), true)
}

section('AT&T soft holds: every schedule route tells the grid which shifts are AT&T')
{
  // The grid and map treat a shift without `att: true` as another client's
  // work, which voids the AT&T soft hold and shows the day as available. Both
  // routes that feed them must set the flag; the client route once did not,
  // and the client view offered AT&T-held days for booking.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs')
  for (const route of ['app/api/schedule/route.ts', 'app/api/client/schedule/route.ts']) {
    const src = fs.readFileSync(route, 'utf8')
    eq(`${route} sets att from the client`, /att:\s*isAttClient\(r\.client\)/.test(src), true)
  }
}

section('AT&T soft holds: give way per day, never the whole month')
{
  // October soft hold; another client books the truck Oct 14-15 only.
  const other = [{ shift_start: '2026-10-14', shift_end: '2026-10-15' }]
  eq('the days of the other job give way', [softHoldYieldsOn('2026-10-14', other), softHoldYieldsOn('2026-10-15', other)], [true, true])
  eq('the rest of the month stays held', ['2026-10-01', '2026-10-13', '2026-10-16', '2026-10-31'].map(d => softHoldYieldsOn(d, other)), [false, false, false, false])
  eq('no other work: held every day', softHoldYieldsOn('2026-10-20', undefined), false)
}

section('AT&T soft holds: client match survives edits to the client record')
eq('"160over90 Inc" is still AT&T', isAttClient('160over90 Inc'), true)
eq('"160 Over 90" is still AT&T', isAttClient('160 Over 90'), true)
eq('"160over90, Inc." is still AT&T', isAttClient('160over90, Inc.'), true)
eq('an unrelated client is not', isAttClient('Over 90 Media'), false)

section('AT&T soft holds: safety valve on releases')
eq('no AT&T trucks at all: release nothing', releaseBlockedReason({ attTrucks: 0, softHolds: 60, wouldRelease: 60 }) !== null, true)
eq('a mass release is blocked (75 of 90)', releaseBlockedReason({ attTrucks: 15, softHolds: 90, wouldRelease: 75 }) !== null, true)
eq('a normal roster change goes through (3 of 60)', releaseBlockedReason({ attTrucks: 57, softHolds: 60, wouldRelease: 3 }), null)
eq('small fleets are not blocked by the share alone (6 of 12)', releaseBlockedReason({ attTrucks: 6, softHolds: 12, wouldRelease: 6 }), null)
eq('nothing to release, nothing to block', releaseBlockedReason({ attTrucks: 0, softHolds: 0, wouldRelease: 0 }), null)

section('AT&T soft holds: releasing for a booking cuts only its dates')
eq('a booking mid-month leaves the soft hold either side', carve('2026-10-01', '2026-10-31', '2026-10-12', '2026-10-15'),
  [{ start: '2026-10-01', end: '2026-10-11' }, { start: '2026-10-16', end: '2026-10-31' }])
eq('a booking at the start leaves the rest', carve('2026-10-01', '2026-10-31', '2026-09-28', '2026-10-03'), [{ start: '2026-10-04', end: '2026-10-31' }])
eq('a booking covering the whole hold leaves nothing', carve('2026-10-01', '2026-10-31', '2026-09-01', '2026-11-30'), [])
eq('a booking elsewhere leaves it untouched', carve('2026-10-01', '2026-10-31', '2026-11-02', '2026-11-05'), [{ start: '2026-10-01', end: '2026-10-31' }])
eq('the warning is exactly as operations asked', ATT_RELEASE_WARNING,
  'Ensure with operations this works, and it only releases for the specific dates of the new booking so that there is no conflict.')

section('AT&T soft holds: a release sticks; the rest of the month is still held')
{
  // October: pieces either side of a released Oct 12-15 booking.
  const pieces = [{ start: '2026-10-01', end: '2026-10-11' }, { start: '2026-10-16', end: '2026-10-31' }]
  const releasedDates = [{ start: '2026-10-12', end: '2026-10-15' }]
  eq('the sync finds nothing to re-create', freeRanges('2026-10-01', '2026-10-31', [...pieces, ...releasedDates]), [])
  eq('without the release record it would put the hold back over the booking', freeRanges('2026-10-01', '2026-10-31', pieces), [{ start: '2026-10-12', end: '2026-10-15' }])
  eq('a released week in a month with no soft hold yet: the rest is still filled', freeRanges('2026-11-01', '2026-11-30', [{ start: '2026-11-09', end: '2026-11-13' }]),
    [{ start: '2026-11-01', end: '2026-11-08' }, { start: '2026-11-14', end: '2026-11-30' }])
  eq('nothing held or released: the whole month', freeRanges('2026-11-01', '2026-11-30', []), [{ start: '2026-11-01', end: '2026-11-30' }])
}

section('AT&T soft holds: clients and partners can never book over one')
{
  const soft = { ok: false, overridable: true, reason: 'STRANDS_SUCCESSOR', detail: 'Would strand ATT_SOFT in Denver, CO on 2026-10-13: needs 2 transport days but only 1 day follow this campaign.' }
  const scheduled = { ok: false, overridable: false, reason: 'BOOKED', detail: 'Truck 412 is scheduled for "Acme Fall Tour" in Dallas from 2026-10-01 to 2026-10-09.' }
  const tooFar = { ok: false, overridable: false, reason: 'INBOUND_TOO_FAR', detail: 'Needs 3 transport days from Denver, CO (900 mi) but only 1 day before start.' }
  eq('a soft hold in the dates: refused, no name', clientBookingRefusal('412', 1, null), 'Truck 412 is not available on these dates.')
  eq('a soft hold it would strand: refused (the gate that used to let it through)', clientBookingRefusal('412', 0, soft), 'Truck 412 is not available on these dates.')
  eq('a scheduled program: refused without naming it', clientBookingRefusal('412', 0, scheduled), 'Truck 412 is not available on these dates.')
  eq('a logistics refusal keeps its reason (no one is named in it)', clientBookingRefusal('412', 0, tooFar), tooFar.detail)
  eq('feasible: goes ahead', clientBookingRefusal('412', 0, { ok: true }), null)
  eq('feasibility lookup failed: goes ahead (fail-open, as everywhere)', clientBookingRefusal('412', 0, null), null)
  const all = [clientBookingRefusal('412', 1, null), clientBookingRefusal('412', 0, soft), clientBookingRefusal('412', 0, scheduled)]
  eq('no client refusal mentions AT&T or another client', all.some(m => /AT&T|ATT_SOFT|Acme/.test(m ?? '')), false)
}

section('AT&T soft holds: staff paths block too, and say why')
{
  eq('a soft hold in the dates: refused, names AT&T (staff must check with ops)', staffBookingRefusal('412', ['ATT_SOFT'], null)?.startsWith('Truck 412 is reserved for AT&T'), true)
  eq('another hold: refused', staffBookingRefusal('412', ['HOLD'], null), 'Conflict: truck already has a hold in this date range')
  eq('a soft hold it would strand: refused, even though overridable', staffBookingRefusal('412', [], { ok: false, overridable: true, detail: 'Would strand ATT_SOFT' }), 'Cannot place hold — Would strand ATT_SOFT')
  eq('feasible: goes ahead', staffBookingRefusal('412', [], { ok: true }), null)
}

section('AT&T soft holds: partner availability names no one')
eq('a soft hold', partnerClashDetail({ yieldable: true, start: '2026-10-01', end: '2026-10-31' }), 'Not available on these dates.')
eq('another client\u2019s program: dates only', partnerClashDetail({ yieldable: false, start: '2026-10-01', end: '2026-10-09' }), 'Booked from 2026-10-01 to 2026-10-09.')

section('AT&T soft holds: soft holds with a market make the strand check fire')
{
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { checkChainFeasibility } = require('@/lib/chainFeasibility') as typeof import('@/lib/chainFeasibility')
  // Booking Dallas Oct 8-11 when AT&T needs the truck in Denver (~660 mi) on Oct 13.
  const soft = (market: string, lat?: number, lng?: number) => ({ start: '2026-10-13', end: '2026-10-31', market, state: '', lat, lng, source: 'HOLD' as const, status: 'ATT_SOFT', yieldable: true })
  const run = (job: ReturnType<typeof soft>) => checkChainFeasibility({
    campaignStart: '2026-10-08', campaignEnd: '2026-10-11', campaignCoords: { lat: 32.78, lng: -96.8 },
    jobs: [job], currentCoords: { lat: 32.78, lng: -96.8 }, today: '2026-09-28',
  })
  const located = run(soft('Denver, CO', 39.74, -104.99))
  eq('a located soft hold that would be stranded is caught', [located.feasible, located.blockedBy, located.overridable], [false, 'STRANDS_SUCCESSOR', true])
  eq('without a location it was invisible (why soft holds now get one)', run(soft('')).feasible, true)
}

section('AT&T soft holds: the sync gives soft holds a market')
{
  const lastMarket = new Map([['412', { market: 'Denver', state: 'CO' }]])
  eq('blank markets are filled from the latest 160over90 work', planMarketBackfill([
    { id: 'a', truck_number: '412', market: '' },
    { id: 'b', truck_number: '412', market: 'Austin' },
    { id: 'c', truck_number: '999', market: '' },
  ], lastMarket), [{ id: 'a', market: 'Denver', state: 'CO' }])
  const fill = planSoftHoldFill({
    window: [{ start: '2026-10-01', end: '2026-10-31', label: 'October 2026' }],
    trucks: ['412', '999'], live: [], releases: [], lastMarket,
  })
  eq('new soft holds carry the market (blank only when none is known)', fill.map(f => [f.truck_number, f.market, f.state]), [['412', 'Denver', 'CO'], ['999', '', '']])
}

section('AT&T soft holds: a release sticks, wherever and whenever it lands')
{
  const window = [
    { start: '2026-09-28', end: '2026-09-30', label: 'September 2026' },
    { start: '2026-10-01', end: '2026-10-31', label: 'October 2026' },
    { start: '2026-11-01', end: '2026-11-30', label: 'November 2026' },
  ]
  const none = new Map<string, { market: string; state: string }>()
  // Released before the sync ever reached November (no soft hold there yet).
  const nov = [{ truck_number: '412', start: '2026-11-09', end: '2026-11-13' }]
  const fill = planSoftHoldFill({ window, trucks: ['412'], live: [], releases: nov, lastMarket: none })
  eq('a release beyond the window: the sync never fills those dates', fill.filter(f => f.start <= '2026-11-13' && f.end >= '2026-11-09'), [])
  eq('...and still fills the rest of November', fill.filter(f => f.label === 'November 2026').map(f => [f.start, f.end]), [['2026-11-01', '2026-11-08'], ['2026-11-14', '2026-11-30']])
  // A soft hold written over a release (the release landed mid-sync).
  const oct = { id: 's1', truck_number: '412', start: '2026-10-01', end: '2026-10-31' }
  eq('a soft hold over a release is cut back around it', planReleaseCuts([oct], [{ truck_number: '412', start: '2026-10-12', end: '2026-10-15' }]),
    [{ id: 's1', keep: [{ start: '2026-10-01', end: '2026-10-11' }, { start: '2026-10-16', end: '2026-10-31' }] }])
  eq('two releases in one month: both cut', planReleaseCuts([oct], [
    { truck_number: '412', start: '2026-10-05', end: '2026-10-06' }, { truck_number: '412', start: '2026-10-20', end: '2026-10-22' },
  ])[0].keep, [{ start: '2026-10-01', end: '2026-10-04' }, { start: '2026-10-07', end: '2026-10-19' }, { start: '2026-10-23', end: '2026-10-31' }])
  eq('another truck\u2019s release: untouched', planReleaseCuts([oct], [{ truck_number: '999', start: '2026-10-12', end: '2026-10-15' }]), [])
  eq('a release record can never be reinstated as a hold', reinstateBlockedByRelease('att_soft_release')?.includes('Undo it from the Conflicts page'), true)
  eq('other expired holds still can', reinstateBlockedByRelease('frontend'), null)
}

section('AT&T soft holds: a release is for one booking')
eq('at most 31 days per release', ATT_RELEASE_MAX_DAYS, 31)
eq('a three-month "release" is refused before anything is touched', validateReleaseRange('2026-09-01', '2026-11-30')?.includes('at most 31 days'), true)
eq('a booking-length release is fine', validateReleaseRange('2026-10-12', '2026-10-15'), null)
eq('bad dates are refused', validateReleaseRange('2026-10-15', '2026-10-12') !== null, true)

section('AT&T list: manual add / take off')
{
  const span = { start: '2026-10-01', end: '2026-12-31' }
  const auto = new Set(['1001'])
  const off = rosterPlan({ span, autoTrucks: auto, overrides: [{ truck_number: '1001', action: 'REMOVE', start: '2026-10-15', end: '2026-11-15' }] })
  eq('taking an AT&T truck off blocks exactly those dates', off.blocks, [{ truck_number: '1001', start: '2026-10-15', end: '2026-11-15' }])
  eq('and adds nobody', off.addTrucks.size, 0)

  const add = rosterPlan({ span, autoTrucks: auto, overrides: [{ truck_number: '2002', action: 'ADD', start: '2026-10-08', end: '2026-10-31' }] })
  eq('an added truck is on the list', [...add.addTrucks], ['2002'])
  eq('but only on its added dates: everything else in the window is blocked', add.blocks,
    [{ truck_number: '2002', start: '2026-10-01', end: '2026-10-07' }, { truck_number: '2002', start: '2026-11-01', end: '2026-12-31' }])

  const swap = rosterPlan({ span, autoTrucks: auto, overrides: [
    { truck_number: '1001', action: 'REMOVE', start: '2026-10-08', end: '2026-12-31' },
    { truck_number: '2002', action: 'ADD', start: '2026-10-08', end: '2026-12-31' },
  ] })
  eq('a swap: one off, one on', [[...swap.addTrucks], swap.blocks.length], [['2002'], 2])

  const noop = rosterPlan({ span, autoTrucks: auto, overrides: [{ truck_number: '1001', action: 'ADD', start: '2026-10-08', end: '2026-10-31' }] })
  eq('adding a truck that is AT&T\'s anyway changes nothing', [noop.addTrucks.size, noop.blocks.length], [0, 0])

  const past = rosterPlan({ span, autoTrucks: auto, overrides: [{ truck_number: '2002', action: 'ADD', start: '2026-08-01', end: '2026-09-30' }] })
  eq('an ended change has no effect', [past.addTrucks.size, past.blocks.length], [0, 0])

  // Through the sync's fill: the added truck gets soft holds only on its dates,
  // the removed one none on its dates.
  const fill = planSoftHoldFill({
    window: [{ start: '2026-10-08', end: '2026-10-31', label: 'October 2026' }],
    trucks: ['1001', '2002'], live: [], lastMarket: new Map(),
    releases: swap.blocks,
  })
  eq('swap fills only the added truck', fill.map(f => `${f.truck_number} ${f.start}..${f.end}`), ['2002 2026-10-08..2026-10-31'])

  const T = '2026-10-08'
  eq('valid change', validateRosterOverride({ action: 'ADD', start: T, end: '2026-10-31', reason: 'swap' }, T), null)
  eq('needs a reason', validateRosterOverride({ action: 'ADD', start: T, end: '2026-10-31', reason: ' ' }, T), 'Say why, so the team knows later.')
  eq('end before start refused', validateRosterOverride({ action: 'REMOVE', start: '2026-10-31', end: T, reason: 'x' }, T) !== null, true)
  eq('already ended refused', validateRosterOverride({ action: 'REMOVE', start: '2026-09-01', end: '2026-09-30', reason: 'x' }, T), 'The end date has already passed.')
  eq('unknown action refused', validateRosterOverride({ action: 'MOVE', start: T, end: T, reason: 'x' }, T), 'Choose add or remove.')
}


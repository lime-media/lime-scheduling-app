/**
 * AT&T soft holds — the pure rules: who counts as AT&T, and the window.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { attLookback, carve, freeRanges, isAttClient, isAttTruck, releaseBlockedReason, softHoldWindow, softHoldYieldsOn, ATT_RELEASE_WARNING } from '@/lib/attSoftRules'

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

section('AT&T soft holds: the partner/MCP API can never book over one')
{
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs')
  const service = fs.readFileSync('lib/holdService.ts', 'utf8')
  const createHoldCheck = service.slice(service.indexOf('export async function createHold'), service.indexOf('Block hold placement if the truck already has a LED schedule'))
  eq('createHold (holds + MCP internal users) counts soft holds as a conflict', !createHoldCheck.includes('excludeAttSoft: true') && createHoldCheck.includes("h.status === 'ATT_SOFT'"), true)
  eq('createHold refuses when only a soft hold would be stranded', /\bif \(!feasibility\.ok\) \{/.test(service), true)
  const mcp = fs.readFileSync('app/api/v1/internal/holds/route.ts', 'utf8')
  eq('MCP client users: soft holds count as a conflict', !mcp.includes('excludeAttSoft: true'), true)
  eq('MCP client users: no soft-hold strand either', /if \(!feasibility\.ok\) \{/.test(mcp), true)
  const avail = fs.readFileSync('app/api/v1/internal/availability/route.ts', 'utf8')
  eq('MCP availability never offers a soft-hold override', !/requires_soft_hold_override:\s*(clash\.yieldable|!chain)/.test(avail), true)
}

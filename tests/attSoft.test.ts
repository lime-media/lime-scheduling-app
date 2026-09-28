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

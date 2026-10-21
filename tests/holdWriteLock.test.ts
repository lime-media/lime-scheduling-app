/**
 * Writing holds without double-booking (lib/holdWriteLock.ts): the clash rule,
 * and every path that chooses a truck writes under the lock. Run with: npm test
 */
import fs from 'fs'
import { eq, section } from './harness'
import { clashesWith } from '@/lib/holdWriteLock'

const d = (s: string) => new Date(s + 'T00:00:00Z')
const hold = (id: string, truck: string, start: string, end: string) => ({ id, truck_number: truck, start_date: d(start), end_date: d(end), client_name: 'Acme', status: 'HOLD' })

section('Hold write lock: what clashes')
{
  const live = [hold('h1', '0044', '2026-11-02', '2026-11-08'), hold('h2', '0051', '2026-11-10', '2026-11-12')]
  const span = (truck: string, start: string, end: string) => [{ truck, start, end }]
  eq('the same truck on overlapping dates', clashesWith(span('0044', '2026-11-05', '2026-11-20'), live, new Set()).map(c => c.truck), ['0044'])
  eq('touching on one day clashes (dates are inclusive)', clashesWith(span('0044', '2026-11-08', '2026-11-09'), live, new Set()).length, 1)
  eq('the day after does not', clashesWith(span('0044', '2026-11-09', '2026-11-12'), live, new Set()).length, 0)
  eq('another truck on the same dates does not', clashesWith(span('0099', '2026-11-02', '2026-11-08'), live, new Set()).length, 0)
  eq('a hold this write replaces or moves does not count', clashesWith(span('0044', '2026-11-02', '2026-11-08'), live, new Set(['h1'])).length, 0)
  eq('several spans: each against its own truck', clashesWith([{ truck: '0044', start: '2026-11-20', end: '2026-11-25' }, { truck: '0051', start: '2026-11-11', end: '2026-11-11' }], live, new Set()).map(c => c.truck), ['0051'])
}

section('Hold write lock: every path that chooses a truck writes under it')
{
  for (const f of ['lib/staffBooking.ts', 'lib/holdRequestService.ts', 'lib/holdService.ts', 'app/api/plan/hold/route.ts', 'app/api/hold-requests/[id]/route.ts', 'app/api/holds/[id]/route.ts', 'app/api/chat/route.ts', 'app/api/v1/internal/holds/route.ts', 'app/api/client/hold-requests/[id]/extend/route.ts']) {
    eq(`${f} writes through writeHoldsExclusive`, fs.readFileSync(f, 'utf8').includes('writeHoldsExclusive('), true)
  }
  const lock = fs.readFileSync('lib/holdWriteLock.ts', 'utf8')
  eq('locks are taken in sorted order (no deadlock)', lock.includes('.sort()') && lock.indexOf('.sort()') < lock.indexOf('EXEC @r = sp_getapplock'), true)
  eq('the lock belongs to the transaction (released with it)', lock.includes("@LockOwner = 'Transaction'"), true)
  const staff = fs.readFileSync('lib/staffBooking.ts', 'utf8')
  eq('a staff booking is all or nothing', staff.includes('tx => tx.hold.createMany({ data: rows })'), true)
  const edit = fs.readFileSync('app/api/holds/[id]/route.ts', 'utf8')
  eq('a hold edit that changes dates (not only the truck) is checked', edit.includes('effStart !== hold.start_date'), true)
  const actions = fs.readFileSync('app/api/hold-requests/[id]/route.ts', 'utf8')
  eq('an expiry edit or approval that revives lapsed-but-unswept holds is re-checked', (actions.match(/await reviveExpiry\(/g) ?? []).length, 2)
  eq('a lock timeout is a 409 to retry, not a 500', fs.readFileSync('lib/staffBooking.ts', 'utf8').includes('err instanceof HoldLockTimeoutError'), true)
  eq('only a live hold moving dates on its own truck lets an AT&T soft hold give way; revivals count soft holds',
    !actions.includes('excludeAttSoft: true') && !fs.readFileSync('app/api/client/hold-requests/[id]/extend/route.ts', 'utf8').includes('excludeAttSoft')
      && fs.readFileSync('app/api/holds/[id]/route.ts', 'utf8').includes('excludeAttSoft: effTruck === hold.truck_number && !revived'), true)
}

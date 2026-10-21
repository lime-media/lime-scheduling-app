/**
 * Reservations page: owner and date filters (lib/reservationFilters.ts).
 * Run with: npm test
 */
import { eq, section } from './harness'
import { ownedBy, ownerOptions, runsBetween } from '@/lib/reservationFilters'

const r = (owner_id: string, owner_name: string, start_date = '2026-11-09', end_date = '2026-11-20') => ({ owner_id, owner_name, start_date, end_date })
// u3 owns an opportunity but has no app login: kept under their Salesforce id and name.
const rows = [r('u1', 'Madison Hill'), r('u2', 'Christian Duffey'), r('u1', 'Madison Hill'), r('sfdc:005X', 'Jack Sargent')]

section('reservations: owner filter')
eq('choices: Everyone, Me, then the others by name', ownerOptions(rows, 'u1').map(o => o.label), ['Everyone', 'Me', 'Christian Duffey', 'Jack Sargent'])
eq('no session: no Me', ownerOptions(rows, null).map(o => o.label), ['Everyone', 'Christian Duffey', 'Jack Sargent', 'Madison Hill'])
eq('Everyone shows all', rows.filter(x => ownedBy(x, 'all', 'u1')).length, 4)
eq('Me shows mine', rows.filter(x => ownedBy(x, 'me', 'u1')).length, 2)
eq('someone else\'s', rows.filter(x => ownedBy(x, 'u2', 'u1')).length, 1)
eq('Me with no session shows nothing rather than everything', rows.filter(x => ownedBy(x, 'me', null)).length, 0)

section('reservations: running between dates')
const b = r('u1', 'M', '2026-11-09', '2026-11-20')
eq('no dates: shown', runsBetween(b, '', ''), true)
eq('a day inside the run', runsBetween(b, '2026-11-15', '2026-11-15'), true)
eq('the first day', runsBetween(b, '2026-11-09', '2026-11-09'), true)
eq('the day after it ends', runsBetween(b, '2026-11-21', '2026-11-21'), false)
eq('a range overlapping the start', runsBetween(b, '2026-11-01', '2026-11-10'), true)
eq('a range before it', runsBetween(b, '2026-11-01', '2026-11-08'), false)
eq('only From: runs on or after it', runsBetween(b, '2026-11-20', ''), true)
eq('only To: starts on or before it', runsBetween(b, '', '2026-11-08'), false)

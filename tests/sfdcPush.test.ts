/**
 * Salesforce LED hold pushes — which ones the app mirrors.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { trucksToMirror } from '@/lib/sfdcIntegration'

const NOW = new Date('2026-10-02T12:00:00Z')
const later = new Date('2026-10-05T23:59:59Z'), earlier = new Date('2026-09-28T00:00:00Z')
const row = (truck_number: string, source: string, status: string, expires_at: Date | null) => ({ truck_number, source, status, expires_at })

section('Salesforce push: trucks the app holds right now are an echo; everything else is mirrored')
eq('created in Salesforce (nothing linked): mirror every truck', trucksToMirror(['9269'], [], NOW), ['9269'])
eq('created by a quote tool, holds live: nothing to mirror', trucksToMirror(['7423', '0820'], [row('7423', 'INTERNAL', 'HOLD', later), row('0820', 'INTERNAL', 'HOLD', later)], NOW), [])
eq('client portal hold, live: echo', trucksToMirror(['7423'], [row('7423', 'CLIENT', 'HOLD', later)], NOW), [])
eq('committed app booking (expiry irrelevant): echo', trucksToMirror(['7423'], [row('7423', 'INTERNAL', 'COMMITTED', earlier)], NOW), [])
eq('quote-only log made a booking in Salesforce (EXPIRED rows reserve nothing): mirror it',
  trucksToMirror(['7423'], [row('7423', 'INTERNAL', 'EXPIRED', NOW)], NOW), ['7423'])
eq('app hold past its expiry (sweep not run yet): mirror it', trucksToMirror(['7423'], [row('7423', 'INTERNAL', 'HOLD', earlier)], NOW), ['7423'])
eq('a rep adds a truck to an app quote in Salesforce: only the new truck is mirrored',
  trucksToMirror(['7423', '1106'], [row('7423', 'INTERNAL', 'HOLD', later)], NOW), ['1106'])
eq('trucks already mirrored from Salesforce are still updated', trucksToMirror(['9269'], [row('9269', 'SALESFORCE', 'HOLD', later)], NOW), ['9269'])

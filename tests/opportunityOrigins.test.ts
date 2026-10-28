/**
 * Where LED opportunities are made (lib/opportunityOrigins.ts), and the
 * refused-field check behind Created_In_App__c (lib/salesforceClient.ts).
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { centralWeekStart, opportunityOrigin, summarizeOrigins, type OriginOpportunity } from '@/lib/opportunityOrigins'
import { fieldRefusedOnWrite, reportFirstFailure } from '@/lib/salesforceClient'

const opp = (id: string, createdAt: string, over: Partial<OriginOpportunity> = {}): OriginOpportunity =>
  ({ id, createdAt, createdBy: 'Rep A', owner: 'Rep A', stage: 'WARM', ...over })
const ID = '006VP00000aaaaaAAA'
const at = (iso: string) => new Date(iso)

section('opportunityOrigin')
eq('recorded by the app', opportunityOrigin(opp(ID, '2026-10-20T15:00:00Z'), new Set([ID.slice(0, 15)]), new Map()), 'app')
eq('a 15-character id on either side still matches', opportunityOrigin(opp(ID.slice(0, 15), '2026-10-20T15:00:00Z'), new Set([ID.slice(0, 15)]), new Map()), 'app')
eq('marked Created In App in Salesforce', opportunityOrigin(opp(ID, '2026-10-20T15:00:00Z', { createdInApp: true }), new Set(), new Map()), 'app')
const holds = new Map([[ID.slice(0, 15), [at('2026-10-20T14:58:30Z')]]])
eq('an app reservation 90 seconds before: matched', opportunityOrigin(opp(ID, '2026-10-20T15:00:00Z'), new Set(), holds), 'app_matched')
eq('exactly 5 minutes apart: matched', opportunityOrigin(opp(ID, '2026-10-20T15:03:30Z'), new Set(), holds), 'app_matched')
eq('just over 5 minutes: direct', opportunityOrigin(opp(ID, '2026-10-20T15:03:31Z'), new Set(), holds), 'salesforce')
eq('an app reservation days later (attached to it): direct', opportunityOrigin(opp(ID, '2026-10-10T15:00:00Z'), new Set(), holds), 'salesforce')
eq('made since the app began recording, unrecorded: direct even with a reservation', opportunityOrigin(opp(ID, '2026-10-20T15:00:00Z'), new Set(), holds, at('2026-10-01T00:00:00Z')), 'salesforce')
eq('made before the app began recording: still matched', opportunityOrigin(opp(ID, '2026-10-20T15:00:00Z'), new Set(), holds, at('2026-10-28T00:00:00Z')), 'app_matched')
eq('nothing from the app: direct', opportunityOrigin(opp(ID, '2026-10-20T15:00:00Z'), new Set(), new Map()), 'salesforce')

section('centralWeekStart')
eq('a Wednesday', centralWeekStart(at('2026-10-28T17:00:00Z')), '2026-10-26')
eq('Monday itself', centralWeekStart(at('2026-10-26T17:00:00Z')), '2026-10-26')
eq('Sunday belongs to the week before', centralWeekStart(at('2026-11-01T17:00:00Z')), '2026-10-26')
eq('Sunday 11pm Central (Monday in UTC) is still the earlier week', centralWeekStart(at('2026-10-26T04:00:00Z')), '2026-10-19')
eq('Monday 12:30am Central is the new week', centralWeekStart(at('2026-10-26T05:30:00Z')), '2026-10-26')

section('summarizeOrigins')
{
  const rows = [
    { opp: opp('a', '2026-10-27T15:00:00Z'), origin: 'app' as const },
    { opp: opp('b', '2026-10-28T15:00:00Z'), origin: 'app_matched' as const },
    { opp: opp('c', '2026-10-28T16:00:00Z', { createdBy: 'Rep B' }), origin: 'salesforce' as const },
    { opp: opp('d', '2026-10-13T16:00:00Z', { createdBy: 'Rep B' }), origin: 'salesforce' as const },
    { opp: opp('e', '2026-10-14T16:00:00Z', { createdBy: 'Rep C' }), origin: 'salesforce' as const },
  ]
  const s = summarizeOrigins(rows, '2026-10-12', '2026-10-26')
  eq('totals', [s.total, s.inApp, s.matched, s.direct], [5, 2, 1, 3])
  eq('share made outside the app', s.directPct, 60)
  eq('every week in the range, empty ones too', s.weeks, [
    { week: '2026-10-12', inApp: 0, direct: 2 },
    { week: '2026-10-19', inApp: 0, direct: 0 },
    { week: '2026-10-26', inApp: 2, direct: 1 },
  ])
  eq('direct ones by who made them, most first', s.byCreator, [{ createdBy: 'Rep B', direct: 2 }, { createdBy: 'Rep C', direct: 1 }])
  eq('the direct ones, newest first', s.direct_opportunities.map(o => o.id), ['c', 'e', 'd'])
  eq('nothing in range', summarizeOrigins([], '2026-10-26', '2026-10-26').directPct, 0)
}

section('fieldRefusedOnWrite')
const F = 'Created_In_App__c'
eq('no such column', fieldRefusedOnWrite([{ errorCode: 'INVALID_FIELD', message: "No such column 'Created_In_App__c' on sobject of type Opportunity" }], F), true)
eq('not writable by this user', fieldRefusedOnWrite([{ errorCode: 'INVALID_FIELD_FOR_INSERT_UPDATE', message: 'Unable to create/update fields: Created_In_App__c.', fields: ['Created_In_App__c'] }], F), true)
eq('another field refused', fieldRefusedOnWrite([{ errorCode: 'INVALID_FIELD', message: "No such column 'Brand_Job_Name__c'" }], F), false)
eq('a different error naming nothing', fieldRefusedOnWrite([{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [CloseDate]' }], F), false)
eq('no errors', fieldRefusedOnWrite(undefined, F), false)

section('reportFirstFailure: which error the rep sees when both creates fail')
{
  const missing = [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [CloseDate]' }]
  const ban = [{ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'LED opportunities must be made in the scheduling app.' }]
  const refused = [{ errorCode: 'INVALID_FIELD', message: "No such column 'Created_In_App__c' on sobject of type Opportunity" }]
  eq('marked first, unrelated failure: the first (not the ban the unmarked retry hits)', reportFirstFailure(true, missing, ban), true)
  eq('marked first, field refused: the unmarked retry\'s', reportFirstFailure(true, refused, missing), false)
  eq('unmarked first (mark skipped), marked retry fails otherwise: the marked retry\'s', reportFirstFailure(false, ban, missing), false)
  eq('unmarked first, marked retry refuses the field: the first', reportFirstFailure(false, missing, refused), true)
}

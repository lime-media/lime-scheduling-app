/**
 * The Opportunity stage the app writes (lib/sfdcStages.ts): S1 for a
 * quote-only log, S3 for a reservation; a reservation moves a lower open
 * stage up to S3 and never moves a deal down.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { newOpportunityStage, reservationStageRaise, QUOTE_ONLY_STAGE, RESERVATION_STAGE } from '@/lib/sfdcStages'
import { updateAttempts } from '@/lib/sfdcBooking'

section('Opportunity stage: what a new opportunity starts at')
eq('a quote-only log: S1', newOpportunityStage(true), 'S1')
eq('a reservation: S3', newOpportunityStage(false), 'S3')
eq('the constants are Salesforce\'s active values', [QUOTE_ONLY_STAGE, RESERVATION_STAGE], ['S1', 'S3'])

section('Opportunity stage: trucks reserved on an existing opportunity')
eq('S1 (a quote-only log turned into a reservation) moves up to S3', reservationStageRaise('S1', true), 'S3')
eq('S2 moves up too', reservationStageRaise('S2', true), 'S3')
eq('the retired COLD and WARM move up', ['COLD', 'WARM', ' warm '].map(s => reservationStageRaise(s, true)), ['S3', 'S3', 'S3'])
eq('S3, S4 and S5 are left where the seller put them', ['S3', 'S4', 'S5'].map(s => reservationStageRaise(s, true)), [null, null, null])
eq('the retired Hot (80%) is never moved down', reservationStageRaise('Hot / Estimate Sent', true), null)
eq('a quote-only log added to it changes nothing', reservationStageRaise('S1', false), null)
eq('no stage known: left alone', reservationStageRaise(null, true), null)

section('Opportunity stage: the update retry order (a refused extra never costs the other)')
{
  const f = { Amount: 1000 }
  const shape = (a: ReturnType<typeof updateAttempts>) => a.map(x => [Object.keys(x.body).sort().join('+'), x.clientTypeLeft])
  eq('raise and Client Type: all, no stage, no Client Type, neither', shape(updateAttempts(f, 'Agency', 'S3')), [
    ['Amount+Client_Type__c+StageName', false],
    ['Amount+Client_Type__c', false],
    ['Amount+StageName', true],
    ['Amount', true],
  ])
  eq('a refused Client Type keeps the raise (the third attempt has StageName S3)', updateAttempts(f, 'Agency', 'S3')[2].body.StageName, 'S3')
  eq('raise only: with it, then without', shape(updateAttempts(f, null, 'S3')), [['Amount+StageName', false], ['Amount', false]])
  eq('Client Type only: with it, then without (told it was left)', shape(updateAttempts(f, 'Brand Direct', null)), [['Amount+Client_Type__c', false], ['Amount', true]])
  eq('neither: one attempt', shape(updateAttempts(f, null, null)), [['Amount', false]])
}

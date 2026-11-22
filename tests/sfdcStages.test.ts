/**
 * The Opportunity stage the app writes (lib/sfdcStages.ts): S1 for a
 * quote-only log, S3 for a reservation; a reservation moves a lower open
 * stage up to S3 and never moves a deal down.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { newOpportunityStage, reservationStageRaise, QUOTE_ONLY_STAGE, RESERVATION_STAGE } from '@/lib/sfdcStages'

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

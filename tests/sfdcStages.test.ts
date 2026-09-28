/**
 * Opportunity stages a quote may set — open stages only.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { openStage, DEFAULT_STAGE, OPEN_STAGES } from '@/lib/sfdcStages'

section('Opportunity stage: open stages only')
eq('the three open stages, as Salesforce spells them', OPEN_STAGES.map(s => s.value), ['COLD', 'WARM', 'Hot / Estimate Sent'])
eq('default is Warm, as before', DEFAULT_STAGE, 'WARM')
eq('each is accepted', ['COLD', 'WARM', 'Hot / Estimate Sent'].map(openStage), ['COLD', 'WARM', 'Hot / Estimate Sent'])
eq('labels work too', ['cold', 'Hot'].map(openStage), ['COLD', 'Hot / Estimate Sent'])
eq('a closed stage is never accepted', ['Closed Won', 'Closed Lost - Budget'].map(openStage), ['WARM', 'WARM'])
eq('nothing chosen: Warm', openStage(undefined), 'WARM')

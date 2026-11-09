/**
 * Opportunities made by Salesforce bots (lib/sfdcBots.ts).
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { madeByBot } from '@/lib/sfdcBots'

section('madeByBot')
eq('the Leah Miles bot', madeByBot({ sfdc_created_by_id: '005VP00000MNXcvYAH' }), true)
eq('a person', madeByBot({ sfdc_created_by_id: '005f200000AN2iUAAT' }), false)
eq('not known yet (before the reconcile fills it)', madeByBot({ sfdc_created_by_id: null }), false)

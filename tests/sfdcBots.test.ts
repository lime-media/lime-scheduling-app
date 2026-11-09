/**
 * Opportunities made by Salesforce bots (lib/sfdcBots.ts).
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { isUserId, madeByBot } from '@/lib/sfdcBots'

section('madeByBot')
eq('the Leah Miles bot', madeByBot({ sfdc_created_by_id: '005VP00000MNXcvYAH' }), true)
eq('a person', madeByBot({ sfdc_created_by_id: '005f200000AN2iUAAT' }), false)
eq('not known yet (before the reconcile fills it)', madeByBot({ sfdc_created_by_id: null }), false)

section('isUserId')
eq('an 18-character user id', isUserId('005VP00000MNXcvYAH'), true)
eq('a 15-character user id (never matches the stored 18)', isUserId('005VP00000MNXcv'), false)
eq('an account id', isUserId('001VP00000MNXcvYAH'), false)

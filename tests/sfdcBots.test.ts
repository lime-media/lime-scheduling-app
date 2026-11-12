/**
 * Opportunities made by Salesforce bots (lib/sfdcBots.ts).
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { isUserId, opportunityCreator } from '@/lib/sfdcBots'

section('opportunityCreator')
eq('the Leah Miles bot', opportunityCreator({ sfdc_opportunity_id: '006VP00000AbCdEYAX', sfdc_created_by_id: '005VP00000MNXcvYAH' }), 'bot')
eq('a person', opportunityCreator({ sfdc_opportunity_id: '006VP00000AbCdEYAX', sfdc_created_by_id: '005f200000AN2iUAAT' }), 'person')
eq('not known yet (before the reconcile fills it): unknown, not a person', opportunityCreator({ sfdc_opportunity_id: '006VP00000AbCdEYAX', sfdc_created_by_id: null }), 'unknown')
eq('a 15-character id (the bot\'s, unchecked): unknown, not a person', opportunityCreator({ sfdc_opportunity_id: '006VP00000AbCdEYAX', sfdc_created_by_id: '005VP00000MNXcv' }), 'unknown')
eq('not a user id at all: unknown, not a person', [opportunityCreator({ sfdc_opportunity_id: '006VP00000AbCdEYAX', sfdc_created_by_id: '00GVP00000MNXcvYAH' }), opportunityCreator({ sfdc_opportunity_id: '006VP00000AbCdEYAX', sfdc_created_by_id: 'Leah Miles' })], ['unknown', 'unknown'])
eq('no opportunity: never a bot, never waits', opportunityCreator({ sfdc_opportunity_id: null, sfdc_created_by_id: null }), 'person')

section('isUserId')
eq('an 18-character user id', isUserId('005VP00000MNXcvYAH'), true)
eq('a 15-character user id (never matches the stored 18)', isUserId('005VP00000MNXcv'), false)
eq('an account id', isUserId('001VP00000MNXcvYAH'), false)

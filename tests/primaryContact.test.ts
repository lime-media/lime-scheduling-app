/**
 * The primary contact on bookings (lib/salesforceClient.ts): the id check the
 * quote and planner bookings run before asking Salesforce whether the contact
 * is on the account. Run with: npm test
 */
import { eq, section } from './harness'
import { isContactId } from '@/lib/salesforceClient'

section('primary contact: what counts as a contact id')
eq('18-character Contact id', isContactId('003VP00000o7gJMYAY'), true)
eq('15-character Contact id', isContactId('003VP00000o7gJM'), true)
eq('missing', isContactId(undefined), false)
eq('empty', isContactId(''), false)
eq('an Account id is not a contact', isContactId('001VP00000ABCDEFGH'), false)
eq('injection-shaped text is not an id', isContactId("003' OR Id != '"), false)

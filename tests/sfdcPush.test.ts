/**
 * Salesforce LED hold pushes — which ones the app mirrors.
 * Run with: npm test
 */
import { eq, section } from './harness'
import { appOwnsOpportunity } from '@/lib/sfdcIntegration'

section('Salesforce push: an Opportunity the app created is an echo, not a new reservation')
eq('created by Salesforce (never seen): mirror it', appOwnsOpportunity([]), false)
eq('already mirrored from Salesforce: update it as before', appOwnsOpportunity(['SALESFORCE', 'SALESFORCE']), false)
eq('created by the internal quote tool: ignore the push', appOwnsOpportunity(['INTERNAL']), true)
eq('created by the client portal: ignore the push', appOwnsOpportunity(['CLIENT']), true)

/**
 * Lead source and client type on a quote's opportunity (lib/sfdcLeadSource.ts,
 * lib/pricing/brandMarkup.ts chosenClientType).
 *
 * Run with: npm test
 */
import fs from 'fs'
import { eq, section } from './harness'
import { parseMcpStaffPricing } from '@/lib/mcpActing'
import { clientVisibleFeatures } from '@/lib/quoteFeatures'
import { CLIENT_PORTAL_LEAD_SOURCE, LEAD_SOURCES, MCP_LEAD_SOURCE, NEED_LEAD_SOURCE, leadSourceOf, readLeadSource } from '@/lib/sfdcLeadSource'
import { brandMarkupFor, chosenClientType } from '@/lib/pricing/brandMarkup'

section('lead source')
eq('the 13 picklist values', LEAD_SOURCES.length, 13)
eq('a picklist value is kept as Salesforce spells it', leadSourceOf('get in touch web form'), 'Get In Touch Web Form')
eq('the curly quote is part of the value', leadSourceOf('EMS ‘25'), 'EMS ‘25')
eq('typed with a straight quote, it is still that value', leadSourceOf("EMS '25"), 'EMS ‘25')
eq('a value no longer on the picklist is not accepted', leadSourceOf('Firefly'), null)
eq('blank is none', leadSourceOf('  '), null)
eq('not a string is none', leadSourceOf(3), null)
eq('a picked value is read', readLeadSource('Trade Show', true), { leadSource: 'Trade Show' })
eq('a value off the picklist is refused, even when optional', 'error' in readLeadSource('Firefly', false), true)
eq('none is refused when required', readLeadSource('', true), { error: NEED_LEAD_SOURCE })
eq('none is fine when not required', readLeadSource(undefined, false), { leadSource: null })
eq('the portal and MCP sources are picklist values', [leadSourceOf(CLIENT_PORTAL_LEAD_SOURCE), leadSourceOf(MCP_LEAD_SOURCE)], [CLIENT_PORTAL_LEAD_SOURCE, MCP_LEAD_SOURCE])

section('client type picked on the quote')
eq('Brand Direct', chosenClientType('Brand Direct'), 'Brand Direct')
eq('Agency', chosenClientType('Agency'), 'Agency')
eq('anything else is no pick (the account decides)', [chosenClientType('brand direct'), chosenClientType(undefined), chosenClientType(true)], [null, null, null])
eq('picking Agency on a Brand Direct account prices with no markup', brandMarkupFor(chosenClientType('Agency') ?? 'Brand Direct', 10), 0)
eq('picking Brand Direct on an Agency account adds it', brandMarkupFor(chosenClientType('Brand Direct') ?? 'Agency', 10), 10)

section('where the opportunity is made')
const sf = fs.readFileSync('lib/salesforceClient.ts', 'utf8')
eq('createOpportunity writes LeadSource', sf.includes('body.LeadSource = input.leadSource'), true)
eq('the Quote page requires a lead source for a new opportunity', fs.readFileSync('app/api/quote/hold/route.ts', 'utf8').includes('requireLeadSource: true'), true)
const planHold = fs.readFileSync('app/api/plan/hold/route.ts', 'utf8')
eq('so does the planner', planHold.includes('readLeadSource(body.leadSource, !body.revise?.bookingKey && !body.attachOpportunityId)'), true)
eq('and a revision that makes a new opportunity', planHold.includes('if (reviseKey && !target && !leadSource) return NextResponse.json({ error: NEED_LEAD_SOURCE, needLeadSource: true }'), true)
eq('a client booking gets the portal or MCP source', fs.readFileSync('lib/clientBooking.ts', 'utf8').includes("opts.origination === 'mcp' ? MCP_LEAD_SOURCE : CLIENT_PORTAL_LEAD_SOURCE"), true)

section('a client never sees internal pricing')
const stored = JSON.stringify({ dailyRate: 1500, brandMarkupPct: 10, clientType: 'Brand Direct', truckDays: 4 })
eq('Brand Direct markup and client type are removed', clientVisibleFeatures(stored), JSON.stringify({ dailyRate: 1500, truckDays: 4 }))
eq('nor the deadhead cost or Salesforce bookkeeping', clientVisibleFeatures(JSON.stringify({ dailyRate: 1500, successorImpact: [{ deltaCost: 900 }], appHoldExp: '2026-11-10' })), JSON.stringify({ dailyRate: 1500 }))
eq('nor the Salesforce account and contact it was booked for', clientVisibleFeatures(JSON.stringify({ dailyRate: 1500, party: { accountId: '001000000000001AAA', contact: { id: '003000000000001AAA', name: 'Pat Lee' } } })), JSON.stringify({ dailyRate: 1500 }))
eq('nothing internal: unchanged', clientVisibleFeatures('{"dailyRate":1500}'), '{"dailyRate":1500}')
eq('none', clientVisibleFeatures(null), null)
eq('unparseable text as stored', clientVisibleFeatures('nope'), 'nope')

section('staff MCP: client type is checked')
eq('Brand Direct is taken', parseMcpStaffPricing({ client_type: 'Brand Direct' }), { sfdc_account_id: undefined, brand_markup_pct: undefined, client_type: 'Brand Direct' })
eq('null is not given', parseMcpStaffPricing({ client_type: null }), { sfdc_account_id: undefined, brand_markup_pct: undefined, client_type: undefined })
eq('blank is not given', parseMcpStaffPricing({ client_type: '' }), { sfdc_account_id: undefined, brand_markup_pct: undefined, client_type: undefined })
eq('anything else is refused', parseMcpStaffPricing({ client_type: 'brand' }), { error: 'client_type must be "Agency" or "Brand Direct"' })

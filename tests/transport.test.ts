/**
 * Transport pricing engine — pure-function coverage.
 * Run with: npm test
 */
import { eq, section } from './harness'
import {
  priceTransport, chargeForLeg, estimatedLegs, needsRepositioning,
  transportDaysFromDistance, type TruckLeg,
} from '@/lib/pricing/transport'
import { countActivationDays, countCalendarDays, defaultDaysPerWeek }
  from '@/lib/pricing/schedule'


const local = (mi: number): TruckLeg => ({ distanceMiles: mi, needsRepositioning: false })
const repo  = (mi: number): TruckLeg => ({ distanceMiles: mi, needsRepositioning: true })
const base = { baseConcurrency: 10 as number | null }

section('leg charge formula (unchanged from old client path)')
eq('300mi = 1 day, no hotel', chargeForLeg(300), 1 * 750 + 350)
eq('500mi = 2 days, 1 hotel', chargeForLeg(500), 2 * 750 + 350 + 210)
eq('1000mi = 3 days, 2 hotels', chargeForLeg(1000), 3 * 750 + 350 + 2 * 210)
eq('overrides applied', chargeForLeg(500, { dayRate: 600, airfare: 300, hotelPerNight: 150 }), 2 * 600 + 300 + 150)

section('service area boundary')
eq('250mi is inside', needsRepositioning(250), false)
eq('250.1mi is outside', needsRepositioning(250.1), true)
eq('custom radius honored', needsRepositioning(300, 450), false)
eq('min 1 transport day', transportDaysFromDistance(10), 1)

section('absorption rule: 10+ activation days AND 10+ lead')
const mixed = [local(20), local(40), repo(400)]
eq('12 days / 15 lead -> ABSORBED',
   priceTransport({ ...base, activationDays: 12, leadBusinessDays: 15, legs: mixed }).outcome, 'ABSORBED')
eq('12 days / 5 lead -> BILLED',
   priceTransport({ ...base, activationDays: 12, leadBusinessDays: 5, legs: mixed }).outcome, 'BILLED')
eq('5 days / 15 lead -> BILLED',
   priceTransport({ ...base, activationDays: 5, leadBusinessDays: 15, legs: mixed }).outcome, 'BILLED')
eq('exactly 10/10 -> ABSORBED',
   priceTransport({ ...base, activationDays: 10, leadBusinessDays: 10, legs: mixed }).outcome, 'ABSORBED')

section('only repositioning trucks are billed')
const billed = priceTransport({ ...base, activationDays: 5, leadBusinessDays: 5, legs: mixed })
eq('1 of 3 trucks billed', billed.repositioningTruckCount, 1)
eq('2 local trucks counted', billed.localTruckCount, 2)
eq('charge = one leg only', billed.charge, chargeForLeg(400))
eq('deposit = 1 day x 1 truck', billed.depositAmount, 750)

section('all-local campaign emits no transport')
const allLocal = priceTransport({ ...base, activationDays: 2, leadBusinessDays: 1, legs: [local(10), local(30)] })
eq('outcome INCLUDED', allLocal.outcome, 'INCLUDED')
eq('charge 0', allLocal.charge, 0)
eq('no deposit', allLocal.depositRequired, false)

section('short flight / rush alone no longer bill a local campaign')
eq('2-day rush, all local -> INCLUDED',
   priceTransport({ ...base, activationDays: 2, leadBusinessDays: 0, legs: [local(5)] }).outcome, 'INCLUDED')

section('rate agreement transport_included')
const inc = priceTransport({ ...base, activationDays: 2, leadBusinessDays: 1, legs: mixed, transportIncluded: true })
eq('outcome ABSORBED', inc.outcome, 'ABSORBED')
eq('charge 0', inc.charge, 0)

section('swarm gate (now on every path)')
eq('4 trucks vs concurrency 3 -> MANUAL_QUOTE',
   priceTransport({ baseConcurrency: 3, activationDays: 12, leadBusinessDays: 12, legs: [local(1), local(1), local(1), local(1)] }).outcome,
   'MANUAL_QUOTE')
eq('3 trucks vs concurrency 3 -> priced',
   priceTransport({ baseConcurrency: 3, activationDays: 12, leadBusinessDays: 12, legs: [local(1), local(1), local(1)] }).outcome,
   'INCLUDED')
eq('null concurrency skips gate',
   priceTransport({ baseConcurrency: null, activationDays: 12, leadBusinessDays: 12, legs: [local(1), local(1), local(1), local(1)] }).outcome,
   'INCLUDED')

section('MCP estimate uses the SAME engine, only different legs')
const mcpLegs = estimatedLegs(3, 400)
const mcp = priceTransport({ ...base, activationDays: 5, leadBusinessDays: 5, legs: mcpLegs })
const client = priceTransport({ ...base, activationDays: 5, leadBusinessDays: 5, legs: [repo(400), repo(400), repo(400)] })
eq('identical legs -> identical result', mcp.charge, client.charge)
eq('MCP estimate bills all 3 (no GPS)', mcp.charge, 3 * chargeForLeg(400))
eq('MCP absorbs on the same 10/10 rule',
   priceTransport({ ...base, activationDays: 10, leadBusinessDays: 10, legs: mcpLegs }).outcome, 'ABSORBED')
eq('estimate inside radius -> no repositioning', estimatedLegs(2, 100)[0].needsRepositioning, false)

section('activation days (the MCP day-count fix)')
// 2026-09-01 is a Tuesday; 2026-09-14 is a Monday.
eq('calendar span', countCalendarDays('2026-09-01', '2026-09-14'), 14)
eq('Mon-Fri activation days', countActivationDays('2026-09-01', '2026-09-14', 5), 10)
eq('Mon-Sat activation days', countActivationDays('2026-09-01', '2026-09-14', 6), 12)
eq('7-day = calendar', countActivationDays('2026-09-01', '2026-09-14', 7), 14)
eq('short campaign defaults to 7d/wk', defaultDaysPerWeek(6), 7)
eq('long campaign defaults to 5d/wk', defaultDaysPerWeek(7), 5)


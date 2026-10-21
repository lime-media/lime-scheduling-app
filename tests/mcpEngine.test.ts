/**
 * MCP quotes, books and checks availability through the app's own code, for
 * whoever the call acts for (lib/mcpActing.ts). Run with: npm test
 */
import fs from 'fs'
import { eq, section } from './harness'

section('MCP: one engine')
{
  const quote = fs.readFileSync('app/api/v1/internal/quote/route.ts', 'utf8')
  const holds = fs.readFileSync('app/api/v1/internal/holds/route.ts', 'utf8')
  const avail = fs.readFileSync('app/api/v1/internal/availability/route.ts', 'utf8')
  eq('quote: clients get the client portal\'s quote, staff the Quote page\'s', quote.includes('await clientQuote(party.session') && quote.includes('await staffQuote('), true)
  eq('quote: no estimated legs or caller-supplied tier any more', /estimatedLegs|market_size_tier|campaign_lat/.test(quote), false)
  eq('quote: a client can\'t name another account', /party\.kind === 'client'[\s\S]*?clientQuote\(party\.session, common/.test(quote), true)
  eq('booking: clients get the portal\'s booking, staff the Quote page\'s, marked MCP',
    holds.includes("await placeClientBooking(party.session") && holds.includes("await placeStaffBooking(") && (holds.match(/origination: 'mcp'/g) ?? []).length === 2, true)
  eq('booking: a named truck is refused', holds.includes('if (body.truck_number !== undefined)'), true)
  eq('booking: a repeat of the same caller\'s booking needs confirm_duplicate', holds.includes('if (body.confirm_duplicate !== true)') && holds.includes('duplicate: true'), true)
  eq('booking: no direct hold writes', /prisma\.hold\.create|createHold\(/.test(holds), false)
  eq('availability: market + truck count is the engine\'s answer, client rules for clients', avail.includes('await clientAvailability(party.session, q)') && avail.includes('await checkAvailability({'), true)
}

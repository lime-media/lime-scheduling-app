/**
 * The client portal AI chat answers availability with the quote form's own
 * rules (lib/clientAvailability.ts) and sees nothing about other clients or
 * the fleet. Run with: npm test
 */
import fs from 'fs'
import { eq, section } from './harness'

section('Client chat: one engine, client rules')
{
  const route = fs.readFileSync('app/api/client/chat/route.ts', 'utf8')
  const quote = fs.readFileSync('lib/clientQuote.ts', 'utf8')
  const context = fs.readFileSync('lib/clientChatContext.ts', 'utf8')
  const availability = fs.readFileSync('lib/clientAvailability.ts', 'utf8')
  eq('current Opus', route.includes("model:         'claude-opus-5-5'"), true)
  eq('no text-parsed actions', route.includes('[ACTION:'), false)
  eq('the chat and the quote form share the availability check',
    route.includes('await clientAvailability(session,') && quote.includes('await clientAvailability(session,'), true)
  eq('the client rules: lead time, own rate card, no AT&T strand override',
    availability.includes('MIN_CLIENT_LEAD_DAYS') && availability.includes('resolveRateOverrides(session)') && !availability.includes('softHoldStrandIsWarning'), true)
  eq('a refusal passes on only the message and market choices', route.includes('message: b.message ?? b.error, candidates: b.candidates })'), true)
  eq('the context is the client\'s own holds only', /client_user_id: session\.id/.test(context) && !context.includes('SCHEDULED_QUERY') && !context.includes('getLiveVehicleLocations'), true)
  eq('still no prices', route.includes('Do NOT attempt to generate prices'), true)
  eq('replies still pass the other-client scrub', route.includes('reply = await scrubOtherClientNames(reply, session.id)'), true)
  const booking = fs.readFileSync('lib/clientBooking.ts', 'utf8')
  eq('paid review (#130): the client booking requires a whole truck count', booking.includes("typeof truck_count !== 'number' || !Number.isInteger(truck_count)"), true)
  const withFallback = fs.readFileSync('app/api/client/chat/route.ts', 'utf8')
  eq('client chat: a safety decline falls back server-side (fallbacks: default)', withFallback.includes('anthropic.beta.messages.create(') && withFallback.includes("'server-side-fallback-2026-07-01'") && /fallbacks:\s+'default'/.test(withFallback), true)
  eq('client chat: a refusal that survives the fallback is still handled', withFallback.includes("stop_reason === 'refusal'"), true)
}

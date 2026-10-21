/**
 * The staff AI chat runs on the app's engine (lib/staffChatTools.ts): quotes
 * and bookings go through the Quote page's code, and a booking needs a quote
 * ref the rep has seen. Run with: npm test
 */
import fs from 'fs'
import { eq, section } from './harness'
import { quoteRef } from '@/lib/quoteRef'

const base = { market: 'Dallas, TX', start_date: '2026-11-02', end_date: '2026-11-08', truck_count: 2, sfdc_account_id: '001000000000001AAA' }
const ref = (q: Partial<typeof base> & Record<string, unknown>, total = 12345.67) => quoteRef({ ...base, ...q } as typeof base, total, 'test-secret')

section('Staff chat: the quote ref')
eq('same inputs and total, same ref', ref({}), ref({}))
eq('shaped Q-XXXXXXXX', /^Q-[0-9A-F]{8}$/.test(ref({})), true)
eq('defaults left out = defaults passed', ref({}), ref({ shadow_fencing: true, smart_directional: false, device_id: false, studies: [], operating_hours: 8 }))
eq('study order and case do not matter', ref({ studies: ['web_lift', 'foot_traffic'] } as never), ref({ studies: ['FOOT_TRAFFIC', 'web_lift'] } as never))
eq('another total, another ref', ref({}, 12345.67) === ref({}, 12399), false)
eq('a cent rounds the same', ref({}, 12345.671), ref({}, 12345.67))
eq('another truck count, another ref', ref({}) === ref({ truck_count: 3 }), false)
eq('another account, another ref (agreement pricing)', ref({}) === ref({ sfdc_account_id: '001000000000002AAA' }), false)
eq('another market, another ref', ref({}) === ref({ market: 'Austin, TX' }), false)
eq('a feature on, another ref', ref({}) === ref({ device_id: true } as never), false)
eq('another secret, another ref', quoteRef(base, 1, 'a') === quoteRef(base, 1, 'b'), false)

section('Staff chat: one engine')
{
  const route = fs.readFileSync('app/api/chat/route.ts', 'utf8')
  const tools = fs.readFileSync('lib/staffChatTools.ts', 'utf8')
  eq('the chat never writes a hold row itself', route.includes('prisma.hold.create'), false)
  eq('no text-parsed actions', route.includes('[ACTION:'), false)
  eq('current Opus', route.includes("model: 'claude-opus-5-5'"), true)
  eq('the shared hidden-truck list', route.includes("from '@/lib/hiddenTrucks'") && !/new Set\(\['0001'/.test(route), true)
  eq('quotes through the Quote page code', tools.includes('await staffQuote(q)'), true)
  eq('bookings through the Quote page code', tools.includes('await placeStaffBooking(body, ctx.actor)'), true)
  eq('availability through the engine', tools.includes('await checkAvailability('), true)
  eq('a booking checks the ref against inputs and total, then that the rep saw it',
    tools.indexOf('quoteRef(q, i.expected_total) !== i.quote_ref.trim()') > -1
      && tools.indexOf('quoteRef(q, i.expected_total)') < tools.indexOf('ctx.shownText.includes(i.quote_ref.trim())')
      && tools.indexOf('ctx.shownText.includes(i.quote_ref.trim())') < tools.indexOf('await placeStaffBooking('), true)
  eq('the rep only "saw" the reply just before this message, not this turn or older ones',
    route.includes("const shown = history.slice(lastUser + 1)") && route.includes('shownText: shown,'), true)
  eq('release is by hold id among live holds', route.includes('findFirst({ where: { id: holdId, ...activeHoldWhere() } })'), true)
  eq('AT&T soft holds are not released by the chat', route.includes("hold.status === 'ATT_SOFT'"), true)
  eq('a release needs the hold id in the reply the rep is answering, one per message', route.includes('!shown.includes(holdId)') && route.includes('if (released) return'), true)
}

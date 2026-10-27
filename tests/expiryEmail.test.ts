/**
 * The expiry reminder: one card per booking, with Extend links
 * (lib/holdExpiryWarnings.ts expiringBookings, lib/emailTemplates.ts).
 *
 * Run with: npm test
 */
import type { Hold } from '@prisma/client'
import { eq, section } from './harness'
import { appUrl, expiringBookings } from '@/lib/holdExpiryWarnings'
import { expiringHoldsHtml, expiringHoldsText } from '@/lib/emailTemplates'
import { readExtendToken } from '@/lib/extendLink'

const NOW = new Date('2026-10-28T15:00:00Z')
const EXP = new Date('2026-10-29T04:59:00.000Z') // end of Oct 28, Central
const hold = (over: Partial<Hold>): Hold => ({
  id: 'h1', truck_number: '6907', market: 'Phoenix, AZ', state: 'AZ', client_name: 'Acme', start_date: new Date('2026-11-09T00:00:00Z'),
  end_date: new Date('2026-11-15T00:00:00Z'), status: 'HOLD', source: 'INTERNAL', created_by: 'u1', expires_at: EXP,
  campaign_group_id: null, sfdc_opportunity_id: null, ...over,
} as Hold)

section('expiringBookings')
const multi = expiringBookings([
  hold({ id: 'a', campaign_group_id: 'mm_abc_1' }),
  hold({ id: 'b', campaign_group_id: 'mm_abc_2', truck_number: '1261', market: 'Albuquerque, NM' }),
  hold({ id: 'c', truck_number: '4322' }),
], NOW, 'secret')
eq('a multi-market booking is one card; a lone hold its own', multi.map(b => b.trucks), [['6907', '1261'], ['4322']])
eq('its markets', multi[0].markets, ['Phoenix, AZ', 'Albuquerque, NM'])
eq('two Extend buttons, to the next two days', multi[0].extend.map(x => [x.days, x.label]), [[1, 'Thu, Oct 29'], [2, 'Fri, Oct 30']])
const t = new URL(multi[0].extend[0].url).searchParams.get('t')!
eq('the link is signed for the rep and the warned expiry', readExtendToken(t, 'secret', NOW.getTime()), { holdId: 'a', userId: 'u1', expiresAt: EXP.toISOString() })
eq('and names the days', new URL(multi[0].extend[1].url).searchParams.get('d'), '2')
eq('a client extension request waiting: no buttons', expiringBookings([hold({ status: 'EXTENSION_REQUESTED' })], NOW, 's')[0].extend, [])
eq('no secret: no buttons', expiringBookings([hold({})], NOW, undefined)[0].extend, [])
// Starting Nov 2: the latest expiry is Oct 30 (2 days before), so +2 (Oct 30) fits and a later one wouldn't.
eq('only days within 2 days before the start', expiringBookings([hold({ start_date: new Date('2026-11-01T00:00:00Z') })], NOW, 's')[0].extend.map(x => x.days), [1])
// Reservations' rule: an expiry may always reach 24 hours from now, however close the start.
eq('the 24-hour floor still allows one day', expiringBookings([hold({ start_date: new Date('2026-10-31T00:00:00Z') })], NOW, 's')[0].extend.map(x => x.days), [1])

section('expiry email template')
const fields = { name: 'Pat', bookings: multi, reservationsUrl: 'https://x/hold-requests' }
const html = expiringHoldsHtml(fields)
eq('a button per offered day', (html.match(/>Extend \d day/g) ?? []).length, 4)
eq('links are attribute-escaped', html.includes('&amp;d=1'), true)
eq('names are escaped', expiringHoldsHtml({ ...fields, bookings: [{ ...multi[1], clientName: '<b>x</b>' }] }).includes('&lt;b&gt;x'), true)
eq('the text version carries the links too', expiringHoldsText(fields).includes(multi[0].extend[0].url), true)
eq('one booking: says hours left', expiringHoldsText({ ...fields, bookings: [multi[1]] }).includes('expires in 14 hours'), true)

section('appUrl')
eq('production: NEXTAUTH_URL', appUrl({ VERCEL_ENV: 'production', NEXTAUTH_URL: 'https://led.lime-media.com/' }), 'https://led.lime-media.com')
eq('a preview (UAT): its branch URL', appUrl({ VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'app-git-uat.vercel.app', NEXTAUTH_URL: 'https://led.lime-media.com' }), 'https://app-git-uat.vercel.app')
eq('nothing set: production', appUrl({}), 'https://led.lime-media.com')

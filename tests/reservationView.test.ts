/**
 * Reservations seller view: bookings, summary tiles, attention flags (lib/reservationView.ts).
 * Run with: npm test
 */
import { eq, section } from './harness'
import { EXPIRING_SOON_HOURS, attentionOf, expiringSoon, groupBookings, summaryTiles, type ViewRow } from '@/lib/reservationView'
import { WARN_WINDOW_HOURS } from '@/lib/holdExpiryWarnings'

const now = new Date('2026-11-13T18:00:00Z')
const today = '2026-11-13'
let n = 0
const row = (over: Partial<ViewRow> = {}): ViewRow => ({
  id: `h${++n}`, campaign_group_id: null, sfdc_opportunity_id: 'opp1', status: 'HOLD', origination: 'frontend', source: 'INTERNAL',
  truck_number: `T${n}`, market: 'Dallas', start_date: '2026-12-01', end_date: '2026-12-10', quoted_total: 1000, pricing_tier: 'Good',
  expires_at: '2026-11-20T05:59:59Z', sfdc_account_id: '001A', led_client: null, led_trucks_unsynced_since: null, ...over,
})

section('reservations view: bookings')
const a1 = row({ campaign_group_id: 'g1' }), a2 = row({ campaign_group_id: 'g1' }), solo = row({ sfdc_opportunity_id: null })
const grouped = groupBookings([a1, solo, a2])
eq('one booking per key, in first-seen order', grouped.map(b => b.rows.length), [2, 1])
eq('a row with no booking stands alone', grouped[1].rows[0].id, solo.id)

section('reservations view: attention')
eq('a priced reservation with an opportunity: nothing', attentionOf([row()]), [])
eq('no quote', attentionOf([row({ quoted_total: null })]), ['no_quote'])
eq('no opportunity', attentionOf([row({ sfdc_opportunity_id: null })]), ['no_opportunity'])
eq('an extension request waiting', attentionOf([row({ status: 'EXTENSION_REQUESTED' })]), ['extension_request'])
eq('won, account not linked to LED', attentionOf([row({ status: 'COMMITTED' })]), ['led_client_unlinked'])
eq('won and linked: nothing', attentionOf([row({ status: 'COMMITTED', led_client: { client_uid: 'x' } })]), [])
eq('LED Trucks not reaching Salesforce', attentionOf([row({ status: 'COMMITTED', led_client: { client_uid: 'x' }, led_trucks_unsynced_since: '2026-11-13T10:00:00Z' })]), ['led_trucks_unsynced'])
eq('expired: nothing to fix', attentionOf([row({ status: 'EXPIRED', quoted_total: null })]), [])
eq('AT&T soft: nothing', attentionOf([row({ status: 'ATT_SOFT', quoted_total: null, sfdc_opportunity_id: null })]), [])
eq('quote-only log: nothing', attentionOf([row({ status: 'EXPIRED', origination: 'quote_only', quoted_total: null })]), [])

section('reservations view: expiring soon')
eq('the tile window is the reminder email window', EXPIRING_SOON_HOURS, WARN_WINDOW_HOURS)
eq('expires in 10 hours: soon', expiringSoon([row({ expires_at: '2026-11-14T04:00:00Z' })], now), '2026-11-14T04:00:00Z')
eq('expires in a week: not soon', expiringSoon([row()], now), null)
eq('already past: not soon (the sweep releases it)', expiringSoon([row({ expires_at: '2026-11-13T12:00:00Z' })], now), null)
eq('won: never', expiringSoon([row({ status: 'COMMITTED', expires_at: '2026-11-14T04:00:00Z' })], now), null)

section('reservations view: tiles')
const mm1 = row({ campaign_group_id: 'mmq_abc_1', quoted_total: 5000, expires_at: '2026-11-14T04:00:00Z' })
const mm2 = row({ campaign_group_id: 'mmq_abc_1', quoted_total: 5000, expires_at: '2026-11-14T04:00:00Z' }) // same market: counted once
const mm3 = row({ campaign_group_id: 'mmq_abc_2', quoted_total: null, expires_at: '2026-11-14T04:00:00Z' })
const tiles = summaryTiles([
  { rows: [mm1, mm2, mm3] },
  { rows: [row({ quoted_total: 2000 })] },
  { rows: [row({ status: 'COMMITTED', quoted_total: 7000 })] },
  { rows: [row({ status: 'COMMITTED', quoted_total: 9000, end_date: '2026-11-01', led_client: { client_uid: 'x' } })] },
  { rows: [row({ status: 'EXPIRED', quoted_total: 4000 })] },
  { rows: [row({ status: 'EXPIRED', origination: 'quote_only', quoted_total: 3000 })] },
  { rows: [row({ status: 'ATT_SOFT', quoted_total: null })] },
], now, today)
eq('open: the two reservations, each market priced once; one has a market with no price', tiles.open, { value: 7000, count: 2, unpriced: 1 })
eq('expiring soon: the multi-market one', tiles.expiring, { value: 5000, count: 1 })
eq('won: running or upcoming only (ended has its own filter)', tiles.won, { value: 7000, count: 1, ledUnlinked: 1 })
eq('attention: the unpriced market and the won one not linked to LED', tiles.attention, { count: 2, byKind: { no_quote: 1, led_client_unlinked: 1 } })
const unpriced = summaryTiles([{ rows: [row({ quoted_total: null })] }], now, today)
eq('an unpriced reservation is counted, not taken as $0 silently', unpriced.open, { value: 0, count: 1, unpriced: 1 })
eq('and flagged', unpriced.attention.byKind, { no_quote: 1 })

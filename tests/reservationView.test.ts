/**
 * Reservations seller view: bookings, summary tiles, attention flags (lib/reservationView.ts).
 * Run with: npm test
 */
import { eq, section } from './harness'
import { EXPIRING_SOON_HOURS, attentionOf, expiringSoon, groupBookings, missingQuote, summaryTiles, tileOf, type ViewRow } from '@/lib/reservationView'
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
eq('a priced reservation with an opportunity: nothing', attentionOf([row()], today), [])
eq('no quote', attentionOf([row({ quoted_total: null })], today), ['no_quote'])
eq('no opportunity', attentionOf([row({ sfdc_opportunity_id: null })], today), ['no_opportunity'])
eq('an extension request waiting', attentionOf([row({ status: 'EXTENSION_REQUESTED' })], today), ['extension_request'])
eq('won, account not linked to LED', attentionOf([row({ status: 'COMMITTED' })], today), ['led_client_unlinked'])
eq('won and linked: nothing', attentionOf([row({ status: 'COMMITTED', led_client: { client_uid: 'x' } })], today), [])
eq('LED Trucks not reaching Salesforce', attentionOf([row({ status: 'COMMITTED', led_client: { client_uid: 'x' }, led_trucks_unsynced_since: '2026-11-13T10:00:00Z' })], today), ['led_trucks_unsynced'])
eq('expired: nothing to fix', attentionOf([row({ status: 'EXPIRED', quoted_total: null })], today), [])
eq('AT&T soft: nothing', attentionOf([row({ status: 'ATT_SOFT', quoted_total: null, sfdc_opportunity_id: null })], today), [])
eq('quote-only log: nothing', attentionOf([row({ status: 'EXPIRED', origination: 'quote_only', quoted_total: null })], today), [])

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
eq('expiring soon: the multi-market one, its unpriced market counted', tiles.expiring, { value: 5000, count: 1, unpriced: 1 })
eq('won: running or upcoming only (ended has its own filter)', tiles.won, { value: 7000, count: 1, unpriced: 0, ledUnlinked: 1 })
eq('attention: the unpriced market and the won one not linked to LED', tiles.attention, { count: 2, byKind: { no_quote: 1, led_client_unlinked: 1 } })
const unpriced = summaryTiles([{ rows: [row({ quoted_total: null })] }], now, today)
eq('an unpriced reservation is counted, not taken as $0 silently', unpriced.open, { value: 0, count: 1, unpriced: 1 })
eq('and flagged', unpriced.attention.byKind, { no_quote: 1 })

section('reservations view: review fixes (#194)')
// Salesforce-made bookings: the app never prices them, so no "No quote".
const sf = [row({ source: 'SALESFORCE', quoted_total: null })]
eq('Salesforce-made, no price: not flagged No quote', attentionOf(sf, today), [])
eq('Salesforce-made: not missing a quote', missingQuote(sf), false)
eq('app-made, no price: still missing a quote', missingQuote([row({ quoted_total: null })]), true)
const sfTiles = summaryTiles([{ rows: sf }, { rows: [row({ status: 'COMMITTED', source: 'SALESFORCE', quoted_total: null, led_client: { client_uid: 'x' } })] }], now, today)
eq('Salesforce-made: counted on Open, not as missing a quote', sfTiles.open, { value: 0, count: 1, unpriced: 0 })
eq('Salesforce-made won: not missing a quote', sfTiles.won, { value: 0, count: 1, unpriced: 0, ledUnlinked: 0 })
eq('Salesforce-made: nothing needs attention', sfTiles.attention.count, 0)
// Unpriced counts on Expiring and Won.
const wonUnpriced = summaryTiles([{ rows: [row({ status: 'COMMITTED', quoted_total: null, led_client: { client_uid: 'x' } })] }], now, today)
eq('won with no price: the tile says so', wonUnpriced.won, { value: 0, count: 1, unpriced: 1, ledUnlinked: 0 })
const expUnpriced = summaryTiles([{ rows: [row({ quoted_total: null, expires_at: '2026-11-14T04:00:00Z' })] }], now, today)
eq('expiring with no price: the tile says so', expUnpriced.expiring, { value: 0, count: 1, unpriced: 1 })
// Ended won bookings: no flags, so Committed and Needs attention agree.
const endedWon = [row({ status: 'COMMITTED', end_date: '2026-11-01', quoted_total: null })]
eq('ended won booking: nothing to fix', attentionOf(endedWon, today), [])
const endedTiles = summaryTiles([{ rows: endedWon }], now, today)
eq('ended won booking: on neither tile', [endedTiles.won.count, endedTiles.won.ledUnlinked, endedTiles.attention.count], [0, 0, 0])
eq('running won booking not linked: both tiles count it', (() => { const t = summaryTiles([{ rows: [row({ status: 'COMMITTED' })] }], now, today); return [t.won.ledUnlinked, t.attention.byKind.led_client_unlinked] })(), [1, 1])
// tileOf: the click-through lists use the same membership as the tiles.
eq('tileOf: a reservation is open, not won', tileOf([row()], now, today), { open: true, expiring: false, won: false })
eq('tileOf: expiring soon is also open', tileOf([row({ expires_at: '2026-11-14T04:00:00Z' })], now, today), { open: true, expiring: true, won: false })
eq('tileOf: a running won booking is won', tileOf([row({ status: 'COMMITTED' })], now, today), { open: false, expiring: false, won: true })
eq('tileOf: an ended won booking is on no tile', tileOf(endedWon, now, today), { open: false, expiring: false, won: false })
eq('tileOf: a quote-only log is on no tile', tileOf([row({ origination: 'quote_only' })], now, today), { open: false, expiring: false, won: false })

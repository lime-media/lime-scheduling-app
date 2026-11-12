/**
 * Sending a booking to LED (lib/coreClient.ts, lib/coreSend.ts): settings,
 * the request body against Core's contract, login and re-login, and the
 * send's refusals and idempotency. No network: Core is a fake fetch.
 *
 * Run with: npm test
 */
import { defer, eq, section } from './harness'
import { buildRequest, type BookingRequest, type RequestHold } from '@/lib/campaignRequests'
import { clearCoreTokens, coreClient, coreConfig, coreDecrypt, coreEncrypt, coreLoginBody, corePayload, CoreError, type CoreConfig, type CorePayload } from '@/lib/coreClient'
import { sendBookingToCore, type SendDeps } from '@/lib/coreSend'
import { creatorsByBooking, type Creator, type SentRow } from '@/lib/ledReadiness'

const DALLAS = '11111111-1111-1111-1111-111111111111'
const CLIENT = '33333333-3333-3333-3333-333333333333'
const ON = { CORE_SEND_ENABLED: 'true', CORE_AUTH_URL: 'https://auth.test/login', CORE_API_URL: 'https://core.test/', CORE_USERNAME: 'app@test', CORE_PASSWORD: 'pw', CORE_CRYPTO_KEY: 'shared-key' }
const BOT = '005VP00000MNXcvYAH'
const PERSON = '005Hs00000000001AA'

let n = 0
const hold = (over: Partial<RequestHold> = {}): RequestHold => ({
  id: `h${++n}`, truck_number: '0101', market: 'Dallas, TX', state: 'TX', client_name: 'Acme Outdoor',
  start_date: '2026-12-07', end_date: '2026-12-20', status: 'HOLD', campaign_group_id: 'cg_1',
  sfdc_opportunity_id: '006Hs00000000001', sfdc_account_id: '001A', sfdc_job_number: null,
  sfdc_created_by_id: PERSON, standard_market_uid: DALLAS, quoted_total: 20000, features: JSON.stringify({ daysPerWeek: 5, operatingHours: 10 }),
  ...over,
})
const linked = () => CLIENT
const build = (holds: RequestHold[], ref: string | null = null) => buildRequest(holds, linked, () => ref)!

section('coreConfig: off unless enabled and complete')
eq('not enabled', coreConfig({ ...ON, CORE_SEND_ENABLED: 'false' }).ok, false)
eq('unset', coreConfig({}).ok, false)
const partial = coreConfig({ ...ON, CORE_PASSWORD: '' })
eq('a setting missing names it', !partial.ok && partial.reason.includes('CORE_PASSWORD'), true)
const full = coreConfig(ON)
eq('enabled and complete; trailing slash dropped', full.ok && full.config.apiUrl, 'https://core.test')
const noKey = coreConfig({ ...ON, CORE_CRYPTO_KEY: ' ' })
eq('no crypto key: off, and says so', !noKey.ok && noKey.reason.includes('CORE_CRYPTO_KEY'), true)

section('coreEncrypt: the login is encrypted as CryptoJS.AES with a passphrase')
// An independent vector from OpenSSL (the format CryptoJS follows):
//   printf '<json>' | openssl enc -aes-256-cbc -md md5 -S 0102030405060708 -pass pass:shared-key -base64 -A
// OpenSSL leaves out the "Salted__" header when the salt is given, so it's added here.
const SALT = Buffer.from('0102030405060708', 'hex')
const LOGIN_JSON = '{"emailAddress":"app@test","password":"pw","applicationType":"web"}'
const OPENSSL_CT = '6StICbY58BEt7fs592OGQkXaYM9Er4Ryc9LnvWlJhAf9a51r2OjK4/yEabKXNE2788eBYHF/5+WRi9nEPoHg2PV+djY5/kx7U8/I4A9yiiM='
const VECTOR = Buffer.concat([Buffer.from('Salted__'), SALT, Buffer.from(OPENSSL_CT, 'base64')]).toString('base64')
eq('matches OpenSSL byte for byte', coreEncrypt(LOGIN_JSON, 'shared-key', SALT), VECTOR)
eq('starts with "Salted__" (U2FsdGVkX1)', coreEncrypt('x', 'k').startsWith('U2FsdGVkX1'), true)
eq('random salt: two encryptions differ', coreEncrypt('x', 'k') !== coreEncrypt('x', 'k'), true)
eq('round trip', coreDecrypt(coreEncrypt('héllo', 'k'), 'k'), 'héllo')
const lb = coreLoginBody({ username: 'app@test', password: 'pw', cryptoKey: 'shared-key' }, SALT)
eq('login body: one field, loginData, with applicationType inside', [Object.keys(lb), JSON.parse(coreDecrypt(lb.loginData, 'shared-key'))],
  [['loginData'], { emailAddress: 'app@test', password: 'pw', applicationType: 'web' }])
eq('login body matches the OpenSSL vector', lb.loginData, VECTOR)

section('corePayload: the contract body')
const two = build([hold({ truck_number: '0102' }), hold({ truck_number: '0101' })])
const p = corePayload(two.request)
eq('builds', p.ok, true)
if (p.ok) {
  eq('top-level fields', [p.body.clientUid, p.body.campaignName, p.body.campaignStartDate, p.body.campaignEndDate, p.body.externalRef, p.body.soldAmount],
    [CLIENT, 'Acme Outdoor', '2026-12-07', '2026-12-20', 'cg_1', 20000])
  eq('market fields', p.body.markets[0], {
    standardMarketUid: DALLAS, marketStartDate: '2026-12-07', marketEndDate: '2026-12-20', duration: 'EXTENDED_FULL_DAY',
    truckCount: 2, operatingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'], truckNumbers: ['0101', '0102'],
  })
  eq('no source, campaignType or job number sent', ['source', 'campaignType', 'jobNumber'].filter(k => k in p.body), [])
}
const unpriced = corePayload(build([hold({ quoted_total: null })]).request)
eq('no price: soldAmount left out', unpriced.ok && 'soldAmount' in unpriced.body, false)
const allWeek = corePayload(build([hold({ features: null })]).request)
eq('unconfirmed schedule sends all seven days', allWeek.ok && allWeek.body.markets[0].operatingDays.length, 7)
const noClient = corePayload(buildRequest([hold()], () => null, () => null)!.request)
eq('no LED client: refused', noClient.ok, false)
const offList = corePayload(build([hold({ standard_market_uid: null, market: 'Smallville, KS', state: 'KS' })]).request)
eq('not on the market list: refused, named', !offList.ok && offList.error.includes('Smallville'), true)
eq('stored reference is the one sent', (() => { const r = corePayload(build([hold()], 'mm_first').request); return r.ok && r.body.externalRef })(), 'mm_first')

section('coreClient: login, token reuse, re-login on 401, otp')
type Call = { url: string; auth: string | null; forward: string | null; body: unknown }
function fakeCore(script: { login?: (i: number) => Response; create?: (i: number, auth: string | null) => Response }) {
  const calls: Call[] = []
  let logins = 0
  let creates = 0
  const doFetch = async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string> | undefined
    const auth = headers?.Authorization ?? null
    calls.push({ url, auth, forward: headers?.['x-forward-to'] ?? null, body: JSON.parse(String(init.body)) })
    if (url === ON.CORE_AUTH_URL) return (script.login ?? (i => json({ success: true, token: `tok${i}` })))(++logins)
    return (script.create ?? (() => json({ statusCode: 200, data: { campaignRequestUid: 'UID-1', requestId: 'REQ-2026-0001', status: 'SUBMITTED' } })))(++creates, auth)
  }
  return { calls, doFetch }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const config = (coreConfig(ON) as { ok: true; config: CoreConfig }).config
const body = (p as { ok: true; body: CorePayload }).body

defer((async () => {
  clearCoreTokens()
  const f = fakeCore({})
  const c = coreClient(config, f.doFetch)
  const first = await c.createCampaign(body)
  await c.createCampaign(body)
  eq('created: uid and request id', [first.coreUid, first.requestId, first.status], ['UID-1', 'REQ-2026-0001', 'SUBMITTED'])
  eq('one login, token reused, posted to /api/v1/campaigns', f.calls.map(x => [x.url, x.auth]),
    [[ON.CORE_AUTH_URL, null], ['https://core.test/api/v1/campaigns', 'Bearer tok1'], ['https://core.test/api/v1/campaigns', 'Bearer tok1']])
  eq('x-forward-to: java on Core calls, not on the login', f.calls.map(x => x.forward), [null, 'java', 'java'])
  eq('login posts only loginData, never the plain password', [Object.keys(f.calls[0].body as object), JSON.stringify(f.calls[0].body).includes('pw')], [['loginData'], false])

  clearCoreTokens()
  const expired = fakeCore({ create: (i) => (i === 1 ? json({ message: 'expired' }, 401) : json({ statusCode: 200, data: { campaignRequestUid: 'UID-2' } })) })
  const r = await coreClient(config, expired.doFetch).createCampaign(body)
  eq('401: logs in again once and retries', [r.coreUid, expired.calls.map(x => x.auth)], ['UID-2', [null, 'Bearer tok1', null, 'Bearer tok2']])
  eq('the retry is forwarded too', expired.calls.map(x => x.forward), [null, 'java', null, 'java'])

  clearCoreTokens()
  const otp = fakeCore({ login: () => json({ success: true, otpRequired: true }) })
  const err = await coreClient(config, otp.doFetch).createCampaign(body).catch(e => e)
  eq('otpRequired: stops with a clear error, no create call', [err instanceof CoreError, /emailed code/.test(err.message), otp.calls.length], [true, true, 1])

  clearCoreTokens()
  const refused = fakeCore({ create: () => json({ statusCode: 400, message: 'Campaign start date cannot be in the past', data: null }, 400) })
  const e2 = await coreClient(config, refused.doFetch).createCampaign(body).catch(e => e)
  eq("Core's refusal is shown verbatim", e2.message, 'LED refused it: Campaign start date cannot be in the past')

  clearCoreTokens()
  const badLogin = fakeCore({ login: () => json({ success: false, message: 'Invalid credentials' }, 401) })
  const e3 = await coreClient(config, badLogin.doFetch).createCampaign(body).catch(e => e)
  eq('bad credentials: says so, password never in the message', [/credentials/.test(e3.message), e3.message.includes('pw')], [true, false])

  // Core's sign-in answers 200 with success: false and the reason in `error`.
  clearCoreTokens()
  const notFound = fakeCore({ login: () => json({ success: false, error: 'User not found.' }) })
  const e4 = await coreClient(config, notFound.doFetch).createCampaign(body).catch(e => e)
  eq('200 with success: false: a refused login, with its error, no create call',
    [e4 instanceof CoreError, e4.message.includes('User not found.'), /credentials/.test(e4.message), notFound.calls.length], [true, true, true, 1])

  clearCoreTokens()
  const tokenAnyway = fakeCore({ login: () => json({ success: false, error: 'Account disabled', token: 'stale' }) })
  const e5 = await coreClient(config, tokenAnyway.doFetch).createCampaign(body).catch(e => e)
  eq('success: false wins over a token in the body', [e5.message.includes('Account disabled'), tokenAnyway.calls.length], [true, 1])

  clearCoreTokens()
  const nested = fakeCore({ login: () => json({ success: true, data: { token: 'tokN' } }) })
  await coreClient(config, nested.doFetch).createCampaign(body)
  eq('token under data is read', nested.calls[1].auth, 'Bearer tokN')

  clearCoreTokens()
  const createRefused = fakeCore({ create: () => json({ success: false, error: 'not found' }) })
  const e6 = await coreClient(config, createRefused.doFetch).createCampaign(body).catch(e => e)
  eq('create answering 200 with success: false: refused with its error', e6.message, 'LED refused it: not found')
})())

section('sendBookingToCore: refusals and idempotency')
function deps(over: Partial<SendDeps> & { bookings?: BookingRequest[]; rows?: Map<string, SentRow>; creators?: Map<string, Creator> } = {}) {
  const rows = over.rows ?? new Map<string, SentRow>()
  const posted: CorePayload[] = []
  const saved: (string | null)[] = []
  const audited: unknown[] = []
  const d: SendDeps = {
    env: ON,
    load: async () => {
      const bookings = over.bookings ?? [two]
      return { bookings, sent: rows, creators: over.creators ?? new Map(bookings.map(b => [b.bookingKey, 'person' as Creator])) }
    },
    ensureRow: async (key, ref) => {
      const have = rows.get(key)
      if (have) return have
      const row: SentRow = { booking_key: key, external_ref: ref, core_uid: null, request_id: null, last_sent_at: null, last_error: null }
      rows.set(key, row)
      return row
    },
    saveSent: async (key, created, fingerprint) => { saved.push(fingerprint); rows.set(key, { ...rows.get(key)!, core_uid: created.coreUid, request_id: created.requestId }) },
    saveError: async (key, message) => { rows.set(key, { ...rows.get(key)!, last_error: message }) },
    create: async b => { posted.push(b); return { coreUid: 'UID-9', requestId: 'REQ-2026-0009', status: 'SUBMITTED' } },
    audit: async (_b, details) => { audited.push(details) },
    ...over,
  }
  return { d, rows, posted, saved, audited }
}

defer((async () => {
  const off = deps({ env: { ...ON, CORE_SEND_ENABLED: '' } })
  const r0 = await sendBookingToCore(two.bookingKey, off.d)
  eq('turned off: refused, nothing posted', [r0.status, off.posted.length], [409, 0])

  const missing = deps()
  eq('unknown booking: 404', (await sendBookingToCore('nope', missing.d)).status, 404)

  const blocked = buildRequest([hold()], () => null, () => null)!
  const nb = deps({ bookings: [blocked] })
  const r1 = await sendBookingToCore(blocked.bookingKey, nb.d)
  eq('not Ready: refused with the reason, nothing posted', [r1.status, /LED client/.test(String(r1.body.error)), nb.posted.length], [409, true, 0])

  const ok = deps()
  const r2 = await sendBookingToCore(two.bookingKey, ok.d)
  eq('Ready: sent, uid stored', [r2.status, r2.body.coreUid, ok.rows.get(two.bookingKey)?.core_uid], [200, 'UID-9', 'UID-9'])
  const r3 = await sendBookingToCore(two.bookingKey, ok.d)
  eq('sent again: returns the stored request, posts nothing', [r3.status, r3.body.already, ok.posted.length], [200, true, 1])

  // A revised booking: its key is new, its row keeps the first reference.
  const revised = new Map<string, SentRow>([[two.bookingKey, { booking_key: two.bookingKey, external_ref: 'mm_original', core_uid: null, request_id: null, last_sent_at: null, last_error: 'timeout' }]])
  const re = deps({ rows: revised })
  await sendBookingToCore(two.bookingKey, re.d)
  eq('resend uses the stored reference', re.posted[0]?.externalRef, 'mm_original')

  const taken = deps({ ensureRow: async () => null })
  const r5 = await sendBookingToCore(two.bookingKey, taken.d)
  eq("reference already another booking's: refused, nothing posted", [r5.status, taken.posted.length], [409, 0])

  const unsaved = deps({ saveSent: async () => { throw new Error('db down') } })
  const r6 = await sendBookingToCore(two.bookingKey, unsaved.d)
  eq("Core created it but the save failed: still reported sent, with a note and the audit row",
    [r6.status, r6.body.sent, r6.body.coreUid, /couldn't record it/.test(String(r6.body.note)), unsaved.audited.length], [200, true, 'UID-9', true, 1])

  eq('first send stores the fingerprint', typeof ok.saved[0], 'string')
  eq('a send after an earlier attempt leaves the fingerprint unknown', re.saved[0], null)

  const botOpen = deps({ creators: new Map([[two.bookingKey, 'bot' as Creator]]) })
  const rb = await sendBookingToCore(two.bookingKey, botOpen.d)
  eq("the bot's booking, not won: refused with the reason, nothing posted, no row",
    [rb.status, /Salesforce bot/.test(String(rb.body.error)), botOpen.posted.length, botOpen.rows.size], [409, true, 0, 0])

  const wonBot = build([hold({ status: 'COMMITTED', sfdc_job_number: '26-0001' })])
  const botWon = deps({ bookings: [wonBot], creators: new Map([[wonBot.bookingKey, 'bot' as Creator]]) })
  const rw = await sendBookingToCore(wonBot.bookingKey, botWon.d)
  eq("the bot's booking once Closed Won: sent like any other", [wonBot.won, rw.status, botWon.posted.length], [true, 200, 1])

  const unread = deps({ creators: new Map([[two.bookingKey, 'unknown' as Creator]]) })
  const ru = await sendBookingToCore(two.bookingKey, unread.d)
  eq('creator not read yet: waits, nothing posted', [ru.status, /isn't read yet/.test(String(ru.body.error)), unread.posted.length], [409, true, 0])

  const absent = deps({ creators: new Map() })
  eq('creator missing from the map: treated as not read, nothing posted', [(await sendBookingToCore(two.bookingKey, absent.d)).status, absent.posted.length], [409, 0])

  const failing = deps({ create: async () => { throw new CoreError('LED refused it: no timezone', 400) } })
  const r4 = await sendBookingToCore(two.bookingKey, failing.d)
  eq("Core refuses: 502 with its message, recorded on the row", [r4.status, r4.body.error, failing.rows.get(two.bookingKey)?.last_error],
    [502, 'LED refused it: no timezone', 'LED refused it: no timezone'])
})())

section('creatorsByBooking: who made each booking\'s opportunity')
{
  const row = (id: string, group: string | null, opp: string | null, by: string | null) => ({ id, campaign_group_id: group, sfdc_opportunity_id: opp, sfdc_created_by_id: by })
  const m = creatorsByBooking([
    row('a1', 'cg_a', '006A', PERSON), row('a2', 'cg_a', '006A', PERSON),
    row('b1', 'cg_b', '006B', PERSON), row('b2', 'cg_b', '006B', BOT),
    row('c1', 'cg_c', '006C', null),
    row('d1', null, null, null),
  ])
  eq('person / any bot hold makes it bot / not read / no opportunity', [m.get('cg_a'), m.get('cg_b'), m.get('cg_c'), m.get('d1')], ['person', 'bot', 'unknown', 'person'])
}

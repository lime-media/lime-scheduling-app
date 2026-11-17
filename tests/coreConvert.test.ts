/**
 * Auto-convert on Closed Won (lib/coreConvert.ts) and the Core calls it uses
 * (lib/coreClient.ts getCampaign, updateCampaign, approveCampaign): which
 * bookings convert, the create → refresh → approve order, Core's
 * already-decided answers (CIQ-CR-050/051), logging replaced ops edits, and
 * recovery from a lost reply. No network: Core is a fake.
 *
 * Run with: npm test
 */
import { defer, eq, section } from './harness'
import { buildRequest, requestFingerprint, type BookingRequest, type RequestHold } from '@/lib/campaignRequests'
import { coreClient, coreConfig, coreDecision, CoreError, type CoreConfig, type CoreDecided, type CorePayload } from '@/lib/coreClient'
import { CONVERT_PER_SWEEP, convertOff, convertWonBookings, toConvert, type ConvertDeps } from '@/lib/coreConvert'
import type { SentRow } from '@/lib/ledReadiness'

const DALLAS = '11111111-1111-1111-1111-111111111111'
const CLIENT = '33333333-3333-3333-3333-333333333333'
const PROGRAM = '2187822B-95A3-43C1-94AA-51ABB0EB832F'
const SEND = { CORE_SEND_ENABLED: 'true', CORE_AUTH_URL: 'https://auth.test/login', CORE_API_URL: 'https://core.test', CORE_USERNAME: 'convert@test', CORE_PASSWORD: 'pw', CORE_CRYPTO_KEY: 'k' }
const ON = { ...SEND, CORE_AUTO_CONVERT: 'true' }
const BOT = '005VP00000MNXcvYAH'
const PERSON = '005Hs00000000001AA'

let n = 0
const hold = (over: Partial<RequestHold> = {}): RequestHold => ({
  id: `c${++n}`, truck_number: '0101', market: 'Dallas, TX', state: 'TX', client_name: 'Acme Outdoor',
  start_date: '2026-12-07', end_date: '2026-12-20', status: 'COMMITTED', campaign_group_id: 'cg_1',
  sfdc_opportunity_id: '006Hs00000000001', sfdc_account_id: '001A', sfdc_job_number: '26-1234',
  sfdc_created_by_id: PERSON, standard_market_uid: DALLAS, quoted_total: 20000, features: JSON.stringify({ daysPerWeek: 5, operatingHours: 10 }),
  ...over,
})
const build = (holds: RequestHold[]) => buildRequest(holds, () => CLIENT, () => null)!
const won = build([hold()])
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

section('coreDecision: what Core already decided')
eq('050: approved, with the program (or merge target)', coreDecision({ statusCode: 409, errorCode: 'CIQ-CR-050', data: { status: 'APPROVED', clientProgramUid: PROGRAM } }), { decided: 'APPROVED', programUid: PROGRAM })
eq('051: declined, no program', coreDecision({ statusCode: 409, errorCode: 'CIQ-CR-051', data: { status: 'DECLINED', clientProgramUid: null } }), { decided: 'DECLINED', programUid: null })
eq('a status with any error code reads too', coreDecision({ errorCode: 'CIQ-CR-049', data: { status: 'approved' } }), { decided: 'APPROVED', programUid: null })
eq('a validation refusal is not a decision', coreDecision({ statusCode: 400, errors: { 'markets[0].timezone': 'Timezone is required.' } }), null)
eq('nothing', coreDecision(null), null)

section('convertOff: needs sending on and CORE_AUTO_CONVERT')
eq('both on', convertOff(ON), null)
eq('sending on, converting not', /CORE_AUTO_CONVERT/.test(convertOff(SEND) ?? ''), true)
eq('converting on, sending off', /CORE_SEND_ENABLED/.test(convertOff({ ...ON, CORE_SEND_ENABLED: '' }) ?? ''), true)

section('toConvert: won, Ready, not yet decided')
const held = build([hold({ status: 'HOLD', sfdc_opportunity_id: '006Hs00000000002' })])
const noJob = build([hold({ sfdc_job_number: null, sfdc_opportunity_id: '006Hs00000000003' })])
const botWon = build([hold({ sfdc_created_by_id: BOT, sfdc_opportunity_id: '006Hs00000000004' })])
const later = build([hold({ start_date: '2027-01-04', end_date: '2027-01-10', sfdc_opportunity_id: '006Hs00000000005' })])
const row = (key: string, over: Partial<SentRow> = {}): SentRow => ({ booking_key: key, external_ref: key, core_uid: null, request_id: null, last_sent_at: null, last_error: null, ...over })
eq('not won, no job number: left; a won bot deal goes; oldest start first',
  toConvert([later, held, noJob, botWon, won], new Map()).map(b => b.bookingKey), [...[botWon.bookingKey, won.bookingKey].sort(), later.bookingKey])
const partWon = build([hold({ sfdc_opportunity_id: '006Hs00000000007' }), hold({ sfdc_opportunity_id: '006Hs00000000007', status: 'HOLD', truck_number: '0102' })])
eq('part won (one hold still HOLD): not converted', [partWon.won, partWon.wholeWon, toConvert([partWon], new Map()).length], [true, false, 0])
eq('no job number is a blocking issue, so it waits', noJob.issues.some(i => i.kind === 'no_job_number' && i.blocking), true)
eq('decided (approved or declined): left',
  toConvert([won, later], new Map([[won.bookingKey, row(won.bookingKey, { core_status: 'APPROVED' })], [later.bookingKey, row(later.bookingKey, { core_status: 'DECLINED' })]])).length, 0)

section('Core client: GET, PUT and approve')
type Call = { method: string; url: string; body: unknown }
function fakeCore(answer: (c: Call) => Response) {
  const calls: Call[] = []
  const doFetch = async (url: string, init: RequestInit) => {
    if (url === SEND.CORE_AUTH_URL) return json({ success: true, token: 'tok' })
    const c = { method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : null }
    calls.push(c)
    return answer(c)
  }
  return { calls, doFetch }
}
const config = (coreConfig(SEND) as { ok: true; config: CoreConfig }).config
const body = { externalRef: 'x' } as unknown as CorePayload

defer((async () => {

  const ok = fakeCore(c => c.method === 'GET'
    ? json({ statusCode: 200, data: { status: 'SUBMITTED', opsEditedAt: '2026-11-16T12:00:00Z', opsEditedBy: 'U-1' } })
    : c.url.endsWith('/approve') ? json({ statusCode: 200, data: { status: 'APPROVED', clientProgramUid: PROGRAM } }) : json({ statusCode: 200, data: {} }))
  const c = coreClient(config, ok.doFetch)
  eq('GET: status and ops edits', await c.getCampaign('UID-1'), { status: 'SUBMITTED', programUid: null, opsEditedAt: '2026-11-16T12:00:00Z', opsEditedBy: 'U-1' })
  eq('PUT replaced: null', await c.updateCampaign('UID-1', body), null)
  eq('approve: converted, with its program', await c.approveCampaign('UID-1', '26-1234'), { decided: 'APPROVED', programUid: PROGRAM })
  eq('the three calls and their paths', ok.calls.map(x => `${x.method} ${x.url}`), [
    'GET https://core.test/api/v1/campaigns/UID-1',
    'PUT https://core.test/api/v1/campaigns/UID-1',
    'POST https://core.test/api/v1/admin/campaigns/UID-1/approve',
  ])
  eq('approve sends only the job number', ok.calls[2].body, { jobNumber: '26-1234' })

  const again = fakeCore(() => json({ statusCode: 409, errorCode: 'CIQ-CR-050', message: 'already approved', data: { status: 'APPROVED', clientProgramUid: PROGRAM } }, 409))
  eq('a second approve: CIQ-CR-050 is success, with the uid', await coreClient(config, again.doFetch).approveCampaign('UID-1', '26-1234'), { decided: 'APPROVED', programUid: PROGRAM })
  const declined = fakeCore(() => json({ statusCode: 409, errorCode: 'CIQ-CR-051', data: { status: 'DECLINED', clientProgramUid: null } }, 409))
  eq('PUT after a decline: the decision, not an error', await coreClient(config, declined.doFetch).updateCampaign('UID-1', body), { decided: 'DECLINED', programUid: null })
  const invalid = fakeCore(() => json({ statusCode: 400, message: 'Validation failed', errors: { 'markets[0].timezone': 'Washington, DC: Timezone is required.' } }, 400))
  const e = await coreClient(config, invalid.doFetch).approveCampaign('UID-1', '26-1234').catch(x => x)
  eq('a field-map refusal names the field', [e instanceof CoreError, e.message], [true, 'LED refused it: Validation failed; Washington, DC: Timezone is required.'])
})())

section('convertWonBookings: create → refresh → approve')
function deps(over: Partial<ConvertDeps> & { bookings?: BookingRequest[]; rows?: Map<string, SentRow>; approveAnswer?: () => Promise<CoreDecided>; state?: { status: string | null; opsEditedAt: string | null } } = {}) {
  const rows = over.rows ?? new Map<string, SentRow>()
  const log: string[] = []
  const audits: [string, Record<string, unknown>][] = []
  const d: ConvertDeps = {
    env: ON,
    load: async () => ({ bookings: over.bookings ?? [won], sent: rows }),
    ledJobs: async () => new Set(),
    send: async key => {
      log.push('send')
      rows.set(key, { ...(rows.get(key) ?? row(key)), core_uid: 'UID-9' })
      return { status: 200, body: { sent: true, already: false, coreUid: 'UID-9' } }
    },
    get: async uid => { log.push(`get ${uid}`); return { status: over.state?.status ?? 'SUBMITTED', programUid: null, opsEditedAt: over.state?.opsEditedAt ?? null, opsEditedBy: 'U-1' } },
    update: async (uid, b) => { log.push(`put ${uid} ${b.externalRef}`); return null },
    approve: async (uid, job) => { log.push(`approve ${uid} ${job}`); return over.approveAnswer ? over.approveAnswer() : { decided: 'APPROVED', programUid: PROGRAM } },
    saveUpdated: async (key, fp) => { log.push('saveUpdated'); rows.set(key, { ...rows.get(key)!, last_sent_hash: fp }) },
    saveDecided: async (key, dd) => { rows.set(key, { ...(rows.get(key) ?? row(key)), core_status: dd.decided, program_uid: dd.programUid }) },
    saveError: async (key, message) => { rows.set(key, { ...(rows.get(key) ?? row(key)), last_error: message }) },
    audit: async (_b, action, details) => { audits.push([action, details]) },
    ...over,
  }
  return { d, rows, log, audits }
}

defer((async () => {
  const off = deps({ env: SEND })
  const r0 = await convertWonBookings(off.d)
  eq('off: says why, calls nothing', [/CORE_AUTO_CONVERT/.test(r0.off ?? ''), off.log], [true, []])

  const fresh = deps()
  const r1 = await convertWonBookings(fresh.d)
  eq('never sent: created, then approved with the job number (no refresh needed)', fresh.log, ['send', 'approve UID-9 26-1234'])
  eq('recorded as converted, with its program; audited', [r1.outcomes, fresh.rows.get(won.bookingKey)?.core_status, fresh.audits.map(a => a[0])],
    [[{ key: won.bookingKey, result: 'converted', programUid: PROGRAM, already: false }], 'APPROVED', ['CONVERT_IN_LED']])
  await convertWonBookings(fresh.d)
  eq('the next sweep leaves it alone', fresh.log.length, 2)

  const fp = requestFingerprint(won.request)
  const same = deps({ rows: new Map([[won.bookingKey, row(won.bookingKey, { core_uid: 'UID-1', last_sent_hash: fp })]]) })
  await convertWonBookings(same.d)
  eq('sent and unchanged: approved straight away, nothing replaced', same.log, ['approve UID-1 26-1234'])

  const sentAt = new Date('2026-11-10T00:00:00Z')
  const changed = deps({ rows: new Map([[won.bookingKey, row(won.bookingKey, { core_uid: 'UID-1', external_ref: 'orig_ref', last_sent_hash: 'old', last_sent_at: sentAt })]]), state: { status: 'SUBMITTED', opsEditedAt: '2026-11-16T12:00:00Z' } })
  await convertWonBookings(changed.d)
  eq('changed since sent: read, PUT (with the first reference), then approve', changed.log, ['get UID-1', 'put UID-1 orig_ref', 'saveUpdated', 'approve UID-1 26-1234'])
  eq('ops edits made after the send are logged before they are replaced', changed.audits[0], ['LED_EDITS_REPLACED', { booking: won.bookingKey, core_uid: 'UID-1', ops_edited_at: '2026-11-16T12:00:00Z', ops_edited_by: 'U-1' }])

  const oldEdit = deps({ rows: new Map([[won.bookingKey, row(won.bookingKey, { core_uid: 'UID-1', last_sent_hash: 'old', last_sent_at: sentAt })]]), state: { status: 'SUBMITTED', opsEditedAt: '2026-11-09T12:00:00Z' } })
  await convertWonBookings(oldEdit.d)
  eq('an edit from before the last send is not logged again', oldEdit.audits.map(a => a[0]), ['CONVERT_IN_LED'])

  const decidedThere = deps({ rows: new Map([[won.bookingKey, row(won.bookingKey, { core_uid: 'UID-1', last_sent_hash: 'old' })]]), state: { status: 'APPROVED', opsEditedAt: null } })
  const r2 = await convertWonBookings(decidedThere.d)
  eq('ops already converted it in LED: recorded, nothing replaced or approved', [decidedThere.log, r2.outcomes[0]], [['get UID-1'], { key: won.bookingKey, result: 'converted', programUid: null, already: true }])

  let attempts = 0
  const lost = deps({
    rows: new Map([[won.bookingKey, row(won.bookingKey, { core_uid: 'UID-1', last_sent_hash: fp })]]),
    approveAnswer: async () => {
      if (++attempts === 1) throw new CoreError("LED didn't answer in time. Sending again is safe.", null)
      return { decided: 'APPROVED', programUid: PROGRAM } // Core's CIQ-CR-050, as the client reads it
    },
  })
  const r3 = await convertWonBookings(lost.d)
  eq('approve reply lost: recorded as a refusal, not converted', [r3.outcomes[0].result, lost.rows.get(won.bookingKey)?.last_error], ['failed', "LED didn't answer in time. Sending again is safe."])
  await convertWonBookings(lost.d)
  eq('the next sweep approves again and records the program', [lost.rows.get(won.bookingKey)?.core_status, lost.rows.get(won.bookingKey)?.program_uid], ['APPROVED', PROGRAM])

  const refusing = deps({ rows: new Map([[won.bookingKey, row(won.bookingKey, { core_uid: 'UID-1', last_sent_hash: fp })]]), approveAnswer: async () => { throw new CoreError('LED refused it: Washington, DC: Timezone is required.', 400) } })
  const r4 = await convertWonBookings(refusing.d)
  eq('a refusal is kept on the row for LED Readiness', [r4.outcomes[0], refusing.rows.get(won.bookingKey)?.core_status],
    [{ key: won.bookingKey, result: 'failed', error: 'LED refused it: Washington, DC: Timezone is required.' }, undefined])

  const declinedNow = deps({ rows: new Map([[won.bookingKey, row(won.bookingKey, { core_uid: 'UID-1', last_sent_hash: fp })]]), approveAnswer: async () => ({ decided: 'DECLINED', programUid: null }) })
  const r5 = await convertWonBookings(declinedNow.d)
  eq('declined in LED: recorded, audited, not retried', [r5.outcomes[0].result, declinedNow.audits.map(a => a[0]), toConvert([won], declinedNow.rows).length], ['declined', ['DECLINED_IN_LED'], 0])

  const byHand = deps({ ledJobs: async jobs => { log0.push(jobs.join()); return new Set(['26-1234']) } })
  const log0: string[] = []
  const r7 = await convertWonBookings(byHand.d)
  eq('never sent, and LED already runs its job (built by hand): nothing sent or approved', [log0, byHand.log, r7.outcomes[0]], [['26-1234'], [], { key: won.bookingKey, result: 'in_led' }])
  const byHandSent = deps({ ledJobs: async () => new Set(['26-1234']), rows: new Map([[won.bookingKey, row(won.bookingKey, { core_uid: 'UID-1', last_sent_hash: fp })]]) })
  const r8 = await convertWonBookings(byHandSent.d)
  eq('sent, LED runs the job, Core says not approved: left alone, never approved', [byHandSent.log, r8.outcomes[0].result], [['get UID-1'], 'in_led'])
  const lostThenLed = deps({ ledJobs: async () => new Set(['26-1234']), state: { status: 'APPROVED', opsEditedAt: null }, rows: new Map([[won.bookingKey, row(won.bookingKey, { core_uid: 'UID-1', last_sent_hash: fp })]]) })
  await convertWonBookings(lostThenLed.d)
  eq('sent, LED runs the job because Core converted it (reply lost): recorded as converted', [lostThenLed.log, lostThenLed.rows.get(won.bookingKey)?.core_status], [['get UID-1'], 'APPROVED'])
  const unreadable = deps({ ledJobs: async () => { throw new Error('LED down') } })
  const e9 = await convertWonBookings(unreadable.d).catch(x => x)
  eq('LED unreadable: throws before anything is sent (the sweep logs it)', [e9 instanceof Error, unreadable.log], [true, []])

  const won2 = build([hold({ sfdc_opportunity_id: '006Hs00000000006', start_date: '2026-12-14' })])
  const down = deps({ bookings: [won, won2], rows: new Map([[won.bookingKey, row(won.bookingKey, { core_uid: 'UID-1', last_sent_hash: fp })]]), approveAnswer: async () => { throw new CoreError("LED couldn't be reached. Sending again is safe.", null) } })
  const r10 = await convertWonBookings(down.d)
  eq('Core unreachable: the rest wait for the next sweep', [r10.outcomes.length, r10.waiting, down.log.includes('send')], [1, 1, false])
  let clock = 0
  const slow = deps({ bookings: [won, won2], now: () => (clock += 40_000) })
  const r11 = await convertWonBookings(slow.d)
  eq('over the time budget: no new booking is started', [r11.outcomes.length, r11.waiting], [1, 1])

  // More hand-built won bookings than one batch, all starting before a newly won one.
  const handBuilt = Array.from({ length: CONVERT_PER_SWEEP + 1 }, (_, i) =>
    build([hold({ sfdc_opportunity_id: `006Hs0000001${String(i).padStart(4, '0')}`, sfdc_job_number: `26-${5000 + i}`, start_date: '2026-11-20' })]))
  const newlyWon = deps({ bookings: [...handBuilt, won2], ledJobs: async () => new Set(handBuilt.map(b => b.request.jobNumber!)) })
  const r12 = await convertWonBookings(newlyWon.d)
  eq('hand-built won bookings never fill the batch: the newly won one still converts', [r12.outcomes.filter(o => o.result === 'in_led').length, newlyWon.rows.get(won2.bookingKey)?.core_status, r12.waiting], [CONVERT_PER_SWEEP + 1, 'APPROVED', 0])

  const notSent = deps({ send: async () => ({ status: 409, body: { error: 'Not sent: no LED client.' } }) })
  const r6 = await convertWonBookings(notSent.d)
  eq('create refused: stops there, with the send\'s reason', r6.outcomes[0], { key: won.bookingKey, result: 'failed', error: 'Not sent: no LED client.' })

  const retried = deps({ rows: new Map([[won.bookingKey, row(won.bookingKey, { last_error: 'timeout' })]]) })
  await convertWonBookings(retried.d)
  eq('an earlier failed create: LED may hold an older copy, so it is refreshed', retried.log, ['send', 'get UID-9', `put UID-9 ${won.bookingKey}`, 'saveUpdated', 'approve UID-9 26-1234'])
})())

/**
 * Auto-convert on Closed Won (Sarah, 2026-11-16/17; Andrew's answers in the
 * handoff): when a booking's deal is won, its request in LED is brought up to
 * date and converted into a program, with no one clicking Approve. Ops are
 * involved only when LED refuses something; the refusal shows on
 * Ops → LED Readiness.
 *
 * Each sweep, for every won booking that is Ready (lib/ledReadiness.ts isReady:
 * a won booking without a job number is blocked) and not yet decided in LED:
 *   1. Never sent: create it (lib/coreSend.ts, the same send as the button).
 *   2. Changed since LED last got it (last_sent_hash), or unknown: read it
 *      (GET), log any ops edits the refresh will replace, and PUT the booking
 *      as it is now. Approve validates what Core holds, so this comes first.
 *   3. Approve with the Salesforce job number. Core builds the program and
 *      its shifts in one go.
 * A won booking whose job number a live LED program already carries was built
 * in LED by hand (every won booking before this existed): it isn't created or
 * approved, so LED never gets a second program for it. One already sent is
 * recorded as decided only if Core says it was.
 * Core answers CIQ-CR-050 for a request already converted (with its program,
 * or the job it merged into) and CIQ-CR-051 for one declined, to a PUT or an
 * approve; both are recorded as the decision, so a lost reply is recovered on
 * the next sweep and nothing is approved twice.
 *
 * Off unless sending is on (coreConfig) and CORE_AUTO_CONVERT is "true", so
 * sending can be switched on before conversion is.
 *
 * Not yet: a converted booking whose deal is then lost. Core archives the
 * program and its shifts (Sarah, 2026-11-17); the call waits for its shape.
 */

import { prisma } from '@/lib/prisma'
import { leftOutOfLed, requestFingerprint, type BookingRequest } from '@/lib/campaignRequests'
import { coreClient, coreConfig, corePayload, CoreError, type CoreDecided, type CorePayload, type CoreRequestState } from '@/lib/coreClient'
import { liveSendDeps, sendBookingToCore, type SendResult } from '@/lib/coreSend'
import { isReady, loadLedBookings, type SentRow } from '@/lib/ledReadiness'
import { ledProgramJobs } from '@/lib/ledJobs'
import { jobKey } from '@/lib/jobNumber'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'

/** Bookings tried per sweep, at most; the rest follow on the next. */
export const CONVERT_PER_SWEEP = 20
/** No booking is started after this long, so the step can't hold the sweep past its limit (each Core call can take 20s). */
export const CONVERT_BUDGET_MS = 60_000

export type ConvertDeps = {
  env: Record<string, string | undefined>
  load: () => Promise<{ bookings: BookingRequest[]; sent: Map<string, SentRow> }>
  /** The job numbers (jobKey) a live LED program already carries (lib/ledJobs.ts ledProgramJobs). */
  ledJobs: (jobs: string[]) => Promise<Set<string>>
  /** Create a booking's request (lib/coreSend.ts sendBookingToCore). */
  send: (bookingKey: string) => Promise<SendResult>
  get: (coreUid: string) => Promise<CoreRequestState>
  update: (coreUid: string, body: CorePayload) => Promise<CoreDecided | null>
  approve: (coreUid: string, jobNumber: string) => Promise<CoreDecided>
  /** Core now holds the booking as `fingerprint`. */
  saveUpdated: (bookingKey: string, fingerprint: string) => Promise<void>
  saveDecided: (bookingKey: string, decided: CoreDecided) => Promise<void>
  saveError: (bookingKey: string, message: string) => Promise<void>
  audit: (b: BookingRequest, action: string, details: Record<string, unknown>) => Promise<void>
  /** The time in ms (tests). */
  now?: () => number
}

export type ConvertOutcome =
  | { key: string; result: 'converted'; programUid: string | null; already: boolean }
  | { key: string; result: 'declined' }
  /** LED already runs its job (built by hand): left alone. */
  | { key: string; result: 'in_led' }
  /** `unreachable`: Core didn't answer, so the rest of this sweep's bookings wait. */
  | { key: string; result: 'failed'; error: string; unreachable?: boolean }

export type ConvertSummary = { off?: string; outcomes: ConvertOutcome[]; waiting: number }

/** Already decided in LED: nothing more to do. */
export const isDecided = (row: SentRow | undefined) => row?.core_status === 'APPROVED' || row?.core_status === 'DECLINED'

/** Why conversion is off here, or null when it's on. Pure. */
export function convertOff(env: Record<string, string | undefined>): string | null {
  const config = coreConfig(env)
  if (!config.ok) return config.reason
  if (env.CORE_AUTO_CONVERT?.trim() !== 'true') return 'Converting won bookings in LED is turned off here (CORE_AUTO_CONVERT).'
  return null
}

/** The won bookings to convert now, oldest start first. Pure. */
export function toConvert(bookings: BookingRequest[], sent: Map<string, SentRow>): BookingRequest[] {
  return bookings
    // Every market won: a part-won booking (before #118) would convert its tentative markets too.
    .filter(b => b.wholeWon && !leftOutOfLed(b) && isReady(b) && !isDecided(sent.get(b.bookingKey)))
    .sort((a, b) => a.request.startDate.localeCompare(b.request.startDate) || a.bookingKey.localeCompare(b.bookingKey))
}

const later = (edited: string | null, sentAt: Date | null | undefined) => {
  if (!edited) return false
  const t = Date.parse(edited)
  return Number.isFinite(t) && (!sentAt || t > sentAt.getTime())
}

async function convertOne(b: BookingRequest, row: SentRow | undefined, inLed: Set<string>, deps: ConvertDeps): Promise<ConvertOutcome> {
  const key = b.bookingKey
  let coreUid = row?.core_uid ?? null
  const fail = async (error: string, unreachable = false): Promise<ConvertOutcome> => {
    await deps.saveError(key, error).catch(e => console.error('[core-convert] error not recorded:', e instanceof Error ? e.message : e))
    return unreachable ? { key, result: 'failed', error, unreachable } : { key, result: 'failed', error }
  }
  // A CoreError with no status: Core couldn't be reached or didn't answer in time.
  const failWith = (err: unknown, fallback: string) =>
    fail(err instanceof CoreError ? err.message : fallback, err instanceof CoreError && err.status === null)
  const decided = async (d: CoreDecided, already: boolean): Promise<ConvertOutcome> => {
    await deps.saveDecided(key, d)
    await deps.audit(b, d.decided === 'APPROVED' ? 'CONVERT_IN_LED' : 'DECLINED_IN_LED', { booking: key, core_uid: coreUid, program_uid: d.programUid, already })
      .catch(e => console.error('[core-convert] audit not recorded:', e instanceof Error ? e.message : e))
    return d.decided === 'APPROVED' ? { key, result: 'converted', programUid: d.programUid, already } : { key, result: 'declined' }
  }

  const payload = corePayload(b.request)
  if (!payload.ok) return fail(`Not converted: ${payload.error}`)
  const jobNumber = b.request.jobNumber
  if (!jobNumber) return fail('Not converted: Salesforce has no job number for it yet.')
  const fingerprint = requestFingerprint(b.request)

  if (inLed.has(jobKey(jobNumber) ?? '')) {
    if (!row?.core_uid) return { key, result: 'in_led' }
    // Sent, and LED runs the job: converted from this request (a lost reply,
    // or ops approving it), or built beside it by hand. Only Core can say.
    try {
      const state = await deps.get(row.core_uid)
      if (state.status === 'APPROVED' || state.status === 'DECLINED') {
        return await decided({ decided: state.status, programUid: state.programUid }, true)
      }
      return { key, result: 'in_led' }
    } catch (err) {
      return failWith(err, 'Reading the request in LED failed unexpectedly.')
    }
  }

  // What Core holds is known to be this booking only when this sweep's own
  // first send created it; otherwise (an earlier attempt, a race) it's refreshed.
  let held = row?.last_sent_hash ?? null
  if (!coreUid) {
    const sent = await deps.send(key)
    const uid = sent.status === 200 && typeof sent.body.coreUid === 'string' ? sent.body.coreUid : null
    // The send records its own refusal on the booking's row.
    if (!uid) return { key, result: 'failed', error: typeof sent.body.error === 'string' ? sent.body.error : 'Not sent to LED.' }
    coreUid = uid
    held = !row && sent.body.already === false ? fingerprint : null
  }

  try {
    if (held !== fingerprint) {
      const state = await deps.get(coreUid)
      if (state.status === 'APPROVED' || state.status === 'DECLINED') return await decided({ decided: state.status, programUid: state.programUid }, true)
      // The PUT replaces Core's copy (agreed): what ops changed in LED since
      // the app last sent it is logged, so it can be put back by hand.
      if (later(state.opsEditedAt, row?.last_sent_at)) {
        await deps.audit(b, 'LED_EDITS_REPLACED', { booking: key, core_uid: coreUid, ops_edited_at: state.opsEditedAt, ops_edited_by: state.opsEditedBy })
          .catch(e => console.error('[core-convert] audit not recorded:', e instanceof Error ? e.message : e))
      }
      const body = { ...payload.body, externalRef: row?.external_ref ?? payload.body.externalRef }
      const put = await deps.update(coreUid, body)
      if (put) return await decided(put, true)
      await deps.saveUpdated(key, fingerprint)
    }
    const d = await deps.approve(coreUid, jobNumber)
    return await decided(d, false)
  } catch (err) {
    if (!(err instanceof CoreError)) console.error('[core-convert] failed:', err instanceof Error ? err.message : err)
    return failWith(err, 'Converting in LED failed unexpectedly.')
  }
}

/** Convert this sweep's won bookings, one at a time. Never throws for one booking's failure. */
export async function convertWonBookings(deps: ConvertDeps): Promise<ConvertSummary> {
  const off = convertOff(deps.env)
  if (off) return { off, outcomes: [], waiting: 0 }
  const { bookings, sent } = await deps.load()
  const candidates = toConvert(bookings, sent)
  if (candidates.length === 0) return { outcomes: [], waiting: 0 }
  // Unread, LED might already run any of them: nothing converts this sweep.
  // Read for every candidate, not just one batch: won bookings built in LED by
  // hand and never sent stay candidates every sweep, and would otherwise fill
  // the batch ahead of newly won ones.
  const inLed = await deps.ledJobs(candidates.map(b => b.request.jobNumber ?? ''))
  const byHand = (b: BookingRequest) => !sent.get(b.bookingKey)?.core_uid && inLed.has(jobKey(b.request.jobNumber) ?? '')
  const outcomes: ConvertOutcome[] = candidates.filter(byHand).map(b => ({ key: b.bookingKey, result: 'in_led' as const }))
  const all = candidates.filter(b => !byHand(b))
  const batch = all.slice(0, CONVERT_PER_SWEEP)
  const now = deps.now ?? Date.now
  const started = now()
  const tried = outcomes.length
  for (const b of batch) {
    if (now() - started > CONVERT_BUDGET_MS) break
    const o = await convertOne(b, sent.get(b.bookingKey), inLed, deps)
    outcomes.push(o)
    if (o.result === 'failed' && o.unreachable) break
  }
  return { outcomes, waiting: all.length - (outcomes.length - tried) }
}

/** The real dependencies: this deployment's settings, the database and Core, acting as the Salesforce service user. */
export async function liveConvertDeps(): Promise<ConvertDeps> {
  const env = process.env
  const serviceUser = await prisma.user.findUnique({ where: { email: SFDC_SERVICE_USER_EMAIL }, select: { id: true } })
  const by = serviceUser?.id ?? null
  const client = () => {
    const config = coreConfig(env)
    if (!config.ok) throw new CoreError(config.reason, null)
    return coreClient(config.config)
  }
  // One read of the bookings per sweep: each create would otherwise reload
  // every live booking. A send only uses it to find the booking and its row
  // as the sweep began, which is what convertOne decided on.
  let loaded: ReturnType<typeof loadLedBookings> | null = null
  const load = () => (loaded ??= loadLedBookings())
  const base = liveSendDeps(by ?? '')
  // Without the service user there's no one to audit as (an empty user_id fails).
  const sendDeps = { ...base, load, audit: by ? base.audit : async () => {} }
  return {
    env,
    load,
    ledJobs: ledProgramJobs,
    send: key => sendBookingToCore(key, sendDeps),
    get: uid => client().getCampaign(uid),
    update: (uid, body) => client().updateCampaign(uid, body),
    approve: (uid, job) => client().approveCampaign(uid, job),
    saveUpdated: async (key, fingerprint) => {
      await prisma.campaignRequestSync.update({ where: { booking_key: key }, data: { last_sent_hash: fingerprint, last_sent_at: new Date(), last_error: null, last_error_at: null } })
    },
    saveDecided: async (key, d) => {
      await prisma.campaignRequestSync.update({ where: { booking_key: key }, data: { core_status: d.decided, program_uid: d.programUid, last_error: null, last_error_at: null } })
    },
    saveError: async (key, message) => {
      await prisma.campaignRequestSync.update({ where: { booking_key: key }, data: { last_error: message, last_error_at: new Date() } })
    },
    audit: async (b, action, details) => {
      if (!by) return
      await prisma.auditLog.create({
        data: { action, truck_number: b.request.markets.flatMap(m => m.trucks).join(', ').slice(0, 100), user_id: by, details: JSON.stringify(details) },
      })
    },
  }
}

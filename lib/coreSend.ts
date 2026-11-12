/**
 * Send one booking to LED as a campaign request (Ops → LED Readiness's
 * "Send to LED"). Only a Ready booking goes (lib/ledReadiness.ts: nothing
 * blocks it), built exactly as the page shows it (lib/campaignRequests.ts).
 *
 * Idempotent. The booking's row in app_campaign_requests fixes the
 * reference Core is sent the first time (external_ref, which a revise keeps),
 * and Core returns the original request for a reference it has seen. A
 * booking already holding Core's uid isn't sent again: the first request
 * stands until Core's update call exists.
 */

import { prisma } from '@/lib/prisma'
import { requestFingerprint, type BookingRequest } from '@/lib/campaignRequests'
import { coreClient, coreConfig, corePayload, CoreError, type CoreCreated, type CorePayload } from '@/lib/coreClient'
import { isReady, loadLedBookings, type Creator, type SentRow } from '@/lib/ledReadiness'

export type SendDeps = {
  env: Record<string, string | undefined>
  load: () => Promise<{ bookings: BookingRequest[]; sent: Map<string, SentRow>; creators: Map<string, Creator> }>
  /** Create the booking's row with its first reference, or keep the one there; null when another booking's row already has that reference. */
  ensureRow: (bookingKey: string, externalRef: string) => Promise<SentRow | null>
  /** `fingerprint`: what LED now holds, or null when it may hold an earlier version. */
  saveSent: (bookingKey: string, created: CoreCreated, fingerprint: string | null) => Promise<void>
  saveError: (bookingKey: string, message: string) => Promise<void>
  create: (body: CorePayload) => Promise<CoreCreated>
  audit: (b: BookingRequest, details: Record<string, unknown>) => Promise<void>
}

export type SendResult = { status: number; body: Record<string, unknown> }

export async function sendBookingToCore(bookingKey: string, deps: SendDeps): Promise<SendResult> {
  const config = coreConfig(deps.env)
  if (!config.ok) return { status: 409, body: { error: config.reason } }

  const { bookings, sent, creators } = await deps.load()
  const booking = bookings.find(b => b.bookingKey === bookingKey)
  if (!booking) return { status: 404, body: { error: 'This booking is no longer live, so there is nothing to send.' } }
  const before = sent.get(bookingKey)
  if (before?.core_uid) return { status: 200, body: { sent: true, already: true, coreUid: before.core_uid, requestId: before.request_id } }
  // The Salesforce bot's deals reach LED only once Closed Won (Andrew,
  // 2026-11-12; lib/sfdcBots.ts). Checked here, not only on the list, so no
  // caller can send one; a creator not read yet waits rather than counting as a person.
  const creator = creators.get(bookingKey) ?? 'unknown'
  if (creator === 'bot' && !booking.won) return { status: 409, body: { error: 'Not sent: the Salesforce bot made this opportunity, and its deals go to LED only once Closed Won.' } }
  if (creator === 'unknown') return { status: 409, body: { error: 'Not sent yet: who made its Salesforce opportunity isn\'t read yet. The sweep reads it within 15 minutes; if this stays, check the opportunity exists.' } }
  if (!isReady(booking)) {
    return { status: 409, body: { error: `Not ready for LED: ${booking.issues.filter(i => i.blocking).map(i => i.message).join(' ')}` } }
  }

  const payload = corePayload(booking.request)
  if (!payload.ok) return { status: 409, body: { error: `Not ready for LED: ${payload.error}` } }

  // The reference is fixed by the row, so a resend (or two at once) sends the same one.
  const row = await deps.ensureRow(bookingKey, payload.body.externalRef)
  // A booking revised away from this key keeps it as its reference: sending
  // it again would return that booking's request, so this one is refused.
  if (!row) return { status: 409, body: { error: `Another booking already went to LED as ${payload.body.externalRef}. Revise this booking to give it its own reference.` } }
  if (row.core_uid) return { status: 200, body: { sent: true, already: true, coreUid: row.core_uid, requestId: row.request_id } }
  const body = { ...payload.body, externalRef: row.external_ref }

  let created: CoreCreated
  try {
    created = await deps.create(body)
  } catch (err) {
    const message = err instanceof CoreError ? err.message : 'Sending to LED failed unexpectedly.'
    if (!(err instanceof CoreError)) console.error('[core-send] send failed:', err instanceof Error ? err.message : err)
    await deps.saveError(bookingKey, message).catch(e => console.error('[core-send] error not recorded:', e instanceof Error ? e.message : e))
    return { status: 502, body: { error: message } }
  }

  // A row from an earlier attempt means LED may already hold a request made
  // from an earlier version of the booking (a reply lost after Core created
  // it), and Core returns that one unchanged. Its fingerprint is then left
  // unknown, so the update call (when Core has one) sends the booking as it is.
  const fingerprint = before ? null : requestFingerprint(booking.request)
  const result = { sent: true, already: false, coreUid: created.coreUid, requestId: created.requestId }
  const audited = deps.audit(booking, { booking: bookingKey, external_ref: row.external_ref, core_uid: created.coreUid, request_id: created.requestId })
    .catch(e => console.error('[core-send] audit not recorded:', e instanceof Error ? e.message : e))
  try {
    await deps.saveSent(bookingKey, created, fingerprint)
  } catch (err) {
    // LED has it; only the app's record failed. Say so rather than "not sent".
    console.error('[core-send] sent, but not recorded:', err instanceof Error ? err.message : err)
    await audited
    return { status: 200, body: { ...result, note: `Sent to LED as ${created.requestId ?? created.coreUid}, but the app couldn't record it. Sending again is safe: LED returns the same request.` } }
  }
  await audited
  return { status: 200, body: result }
}

const ROW_SELECT = { booking_key: true, external_ref: true, core_uid: true, request_id: true, last_sent_at: true, last_error: true } as const

/** The real dependencies: this deployment's settings, the database and Core. */
export function liveSendDeps(userId: string): SendDeps {
  const env = process.env
  return {
    env,
    load: loadLedBookings,
    ensureRow: async (bookingKey, externalRef) => {
      try {
        return await prisma.campaignRequestSync.upsert({
          where: { booking_key: bookingKey },
          create: { booking_key: bookingKey, external_ref: externalRef },
          update: {},
          select: ROW_SELECT,
        })
      } catch (err) {
        // Two sends at once: the other created it. Read what it wrote.
        const row = await prisma.campaignRequestSync.findUnique({ where: { booking_key: bookingKey }, select: ROW_SELECT })
        if (row) return row
        // No row of its own: the reference belongs to another booking's row.
        const taken = await prisma.campaignRequestSync.findUnique({ where: { external_ref: externalRef }, select: { booking_key: true } })
        if (taken) return null
        throw err
      }
    },
    saveSent: async (bookingKey, created, fingerprint) => {
      await prisma.campaignRequestSync.update({
        where: { booking_key: bookingKey },
        data: { core_uid: created.coreUid, request_id: created.requestId, core_status: created.status, last_sent_hash: fingerprint, last_sent_at: new Date(), last_error: null, last_error_at: null },
      })
    },
    saveError: async (bookingKey, message) => {
      await prisma.campaignRequestSync.update({ where: { booking_key: bookingKey }, data: { last_error: message, last_error_at: new Date() } })
    },
    create: body => {
      const config = coreConfig(env)
      if (!config.ok) throw new CoreError(config.reason, null)
      return coreClient(config.config).createCampaign(body)
    },
    audit: async (b, details) => {
      await prisma.auditLog.create({
        data: { action: 'SEND_TO_LED', truck_number: b.request.markets.flatMap(m => m.trucks).join(', ').slice(0, 100), user_id: userId, details: JSON.stringify(details) },
      })
    },
  }
}

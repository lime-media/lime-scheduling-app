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
import { isReady, loadLedBookings, type SentRow } from '@/lib/ledReadiness'

export type SendDeps = {
  env: Record<string, string | undefined>
  load: () => Promise<{ bookings: BookingRequest[]; sent: Map<string, SentRow> }>
  /** Create the booking's row with its first reference, or keep the one there. */
  ensureRow: (bookingKey: string, externalRef: string) => Promise<SentRow>
  saveSent: (bookingKey: string, created: CoreCreated, fingerprint: string) => Promise<void>
  saveError: (bookingKey: string, message: string) => Promise<void>
  create: (body: CorePayload) => Promise<CoreCreated>
  audit: (b: BookingRequest, details: Record<string, unknown>) => Promise<void>
}

export type SendResult = { status: number; body: Record<string, unknown> }

export async function sendBookingToCore(bookingKey: string, deps: SendDeps): Promise<SendResult> {
  const config = coreConfig(deps.env)
  if (!config.ok) return { status: 409, body: { error: config.reason } }

  const { bookings, sent } = await deps.load()
  const booking = bookings.find(b => b.bookingKey === bookingKey)
  if (!booking) return { status: 404, body: { error: 'This booking is no longer live, so there is nothing to send.' } }
  const before = sent.get(bookingKey)
  if (before?.core_uid) return { status: 200, body: { sent: true, already: true, coreUid: before.core_uid, requestId: before.request_id } }
  if (!isReady(booking)) {
    return { status: 409, body: { error: `Not ready for LED: ${booking.issues.filter(i => i.blocking).map(i => i.message).join(' ')}` } }
  }

  const payload = corePayload(booking.request)
  if (!payload.ok) return { status: 409, body: { error: `Not ready for LED: ${payload.error}` } }

  // The reference is fixed by the row, so a resend (or two at once) sends the same one.
  const row = await deps.ensureRow(bookingKey, payload.body.externalRef)
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

  await deps.saveSent(bookingKey, created, requestFingerprint(booking.request))
  await deps.audit(booking, { booking: bookingKey, external_ref: row.external_ref, core_uid: created.coreUid, request_id: created.requestId })
    .catch(e => console.error('[core-send] audit not recorded:', e instanceof Error ? e.message : e))
  return { status: 200, body: { sent: true, already: false, coreUid: created.coreUid, requestId: created.requestId } }
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

/**
 * EMAIL_REDIRECT_TO: every email this deployment sends goes to that one
 * address instead of its real recipients. Set on UAT, which shares
 * production's SMTP and would otherwise email real reps and clients about
 * test bookings. The subject names who it would have gone to.
 */

type Message = { to?: unknown; cc?: unknown; bcc?: unknown; subject?: unknown; [k: string]: unknown }
type Transport = { sendMail: (message: never) => Promise<unknown> }

const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean)

/** The message as sent while redirecting to `to` (or unchanged when `to` is empty). Pure. */
export function redirectedMessage<M extends Message>(message: M, to: string | undefined): M {
  const target = to?.trim()
  if (!target) return message
  const original = [...list(message.to), ...list(message.cc), ...list(message.bcc)]
  return {
    ...message,
    to: target,
    cc: undefined,
    bcc: undefined,
    subject: `[Redirected from ${original.join(', ') || 'no one'}] ${String(message.subject ?? '')}`,
  }
}

/** A mail transport whose sendMail honours EMAIL_REDIRECT_TO. */
export function redirectingTransport<T extends Transport>(transport: T): T {
  const send = transport.sendMail.bind(transport) as (m: Message) => Promise<unknown>
  return Object.assign(transport, {
    sendMail: (message: Message) => send(redirectedMessage(message, process.env.EMAIL_REDIRECT_TO)),
  })
}

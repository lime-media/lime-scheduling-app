/**
 * Where this deployment's email goes. EMAIL_REDIRECT_TO: every email goes to
 * that one address instead of its real recipients, named in the subject. A
 * preview deployment (UAT shares production's SMTP) without it sends nothing,
 * so test bookings never email real reps and clients. Login codes are the
 * exception (smtpTransport's `direct`): they must reach the person logging in.
 */

type Message = { to?: unknown; cc?: unknown; bcc?: unknown; subject?: unknown; [k: string]: unknown }
type Transport = { sendMail: (message: never) => Promise<unknown> }

// nodemailer takes an address as a string or as { name, address }.
const address = (a: unknown) => String(a && typeof a === 'object' && 'address' in a ? (a as { address: unknown }).address : a)
const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map(address).filter(Boolean)

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

/** What happens to this deployment's email: sent as addressed, redirected, or not sent. Pure. */
export function mailPolicy(env: Record<string, string | undefined>): { kind: 'send' } | { kind: 'redirect'; to: string } | { kind: 'drop' } {
  const to = env.EMAIL_REDIRECT_TO?.trim()
  if (to) return { kind: 'redirect', to }
  return env.VERCEL_ENV === 'preview' ? { kind: 'drop' } : { kind: 'send' }
}

/** A mail transport whose sendMail follows mailPolicy. */
export function redirectingTransport<T extends Transport>(transport: T): T {
  const send = transport.sendMail.bind(transport) as (m: Message) => Promise<unknown>
  return Object.assign(transport, {
    sendMail: async (message: Message) => {
      const policy = mailPolicy(process.env)
      if (policy.kind === 'drop') {
        console.log(`[email] preview deployment without EMAIL_REDIRECT_TO: not sent to ${list(message.to).join(', ')}: ${String(message.subject ?? '')}`)
        return null
      }
      return send(policy.kind === 'redirect' ? redirectedMessage(message, policy.to) : message)
    },
  })
}

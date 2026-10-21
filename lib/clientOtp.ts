/**
 * Login codes for the client portal — the same rules as internal login
 * (lib/otp.ts: one live code, 10-minute expiry, 5 attempts, 45-second resend
 * cooldown), against dbo.app_client_login_otps instead of dbo.app_login_otps.
 *
 * A client with no email on file cannot be sent a code and so cannot log in.
 * That is deliberate: there is no password-only path once this is on. Ops
 * sets the address on the Users page.
 */

import { prisma } from '@/lib/prisma'
import { checkOtp, issueOtp, type OtpStore } from '@/lib/otp'

const clientStore: OtpStore = {
  lastIssued:     (id) => prisma.clientOtpCode.findFirst({ where: { client_user_id: id }, orderBy: { created_at: 'desc' } }),
  liveCode:       (id) => prisma.clientOtpCode.findFirst({ where: { client_user_id: id, consumed_at: null }, orderBy: { created_at: 'desc' } }),
  dropUnconsumed: async (id) => { await prisma.clientOtpCode.deleteMany({ where: { client_user_id: id, consumed_at: null } }) },
  issue:          async (id, code_hash, expires_at) => { await prisma.clientOtpCode.create({ data: { client_user_id: id, code_hash, expires_at } }) },
  countAttempt:   async (id) => { await prisma.clientOtpCode.update({ where: { id }, data: { attempts: { increment: 1 } } }) },
  consume:        async (id) => { await prisma.clientOtpCode.update({ where: { id }, data: { consumed_at: new Date() } }) },
  recordActivity: async (id) => {
    // A login is activity (Users page "Last activity"). Never fails the login.
    await prisma.clientUser.update({ where: { id }, data: { last_active_at: new Date() } })
      .catch(err => console.error('[client otp] last activity not recorded:', err instanceof Error ? err.message : err))
  },
}

/** Thrown when the client has no email, so no code can reach them. */
export class NoClientEmailError extends Error {
  constructor() {
    super('No email address is on file for this account. Contact Lime Media to add one.')
  }
}

/**
 * Issues and emails a login code. Throws NoClientEmailError when there is no
 * address to send to, and OtpRateLimitError when asked again too soon.
 */
export async function requestClientLoginOtp(clientUserId: string, email: string | null, companyName: string): Promise<void> {
  const to = (email ?? '').trim()
  if (!to) throw new NoClientEmailError()
  await issueOtp(clientStore, clientUserId, to, companyName)
}

/** Verifies a submitted code; throws a user-facing Error on any failure. */
export const verifyClientLoginOtp = (clientUserId: string, submittedCode: string): Promise<void> =>
  checkOtp(clientStore, clientUserId, submittedCode)

/**
 * Where a code was sent, shown on the login screen so the person knows which
 * inbox to check without the address being readable to anyone who guesses a
 * username: "jo***@example.com".
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return '***'
  const name = email.slice(0, at)
  // A fixed mask, not one per hidden character: the number of stars must not
  // give away how long the address is.
  return `${name.slice(0, 2)}***${email.slice(at)}`
}

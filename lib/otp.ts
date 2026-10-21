import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { sendOtpEmail } from '@/lib/email'

export const CODE_TTL_MINUTES     = 10
export const MAX_ATTEMPTS         = 5
export const RESEND_COOLDOWN_SECS = 45

export class OtpRateLimitError extends Error {
  constructor(public secondsLeft: number) {
    super(`Please wait ${secondsLeft}s before requesting another code.`)
  }
}

function generateCode(): string {
  // 000000–999999, cryptographically random — not Math.random()
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

/**
 * The storage a login-code flow needs. Internal users (OtpCode, keyed to
 * User) and client-portal users (ClientOtpCode, keyed to ClientUser) live in
 * different tables with different foreign keys, so the rules — one live code
 * at a time, 10-minute expiry, 5 attempts, 45-second resend cooldown — are
 * written once here and the table access is passed in.
 */
export type OtpStore = {
  /** The owner's most recent code of any kind, for the resend cooldown. */
  lastIssued:       (ownerId: string) => Promise<{ created_at: Date } | null>
  /** The owner's most recent unconsumed code, for verification. */
  liveCode:         (ownerId: string) => Promise<{ id: string; code_hash: string; expires_at: Date; attempts: number } | null>
  dropUnconsumed:   (ownerId: string) => Promise<void>
  issue:            (ownerId: string, codeHash: string, expiresAt: Date) => Promise<void>
  countAttempt:     (codeId: string) => Promise<void>
  consume:          (codeId: string) => Promise<void>
  /** Login counts as activity for the Users page. Must never fail the login. */
  recordActivity:   (ownerId: string) => Promise<void>
}

/**
 * Issues a fresh login code, emails it, and invalidates any previously-issued
 * unconsumed code so only one is ever valid at once. Throws OtpRateLimitError
 * if called again too soon after the last request.
 */
export async function issueOtp(store: OtpStore, ownerId: string, email: string, name: string): Promise<void> {
  const lastSent = await store.lastIssued(ownerId)

  if (lastSent) {
    const secondsSince = (Date.now() - lastSent.created_at.getTime()) / 1000
    if (secondsSince < RESEND_COOLDOWN_SECS) {
      throw new OtpRateLimitError(Math.ceil(RESEND_COOLDOWN_SECS - secondsSince))
    }
  }

  const code = generateCode()
  const code_hash = await bcrypt.hash(code, 10)

  // Only one active code per user — clear out anything still outstanding
  // before issuing the new one.
  await store.dropUnconsumed(ownerId)
  await store.issue(ownerId, code_hash, new Date(Date.now() + CODE_TTL_MINUTES * 60_000))

  await sendOtpEmail({ to: email, name, code, ttlMinutes: CODE_TTL_MINUTES })
}

/**
 * Verifies a submitted code. Throws a user-facing Error on any failure (no
 * code on file, expired, too many attempts, wrong code) — callers let these
 * propagate so the message reaches the person typing. On success, marks the
 * code consumed so it can't be replayed.
 */
export async function checkOtp(store: OtpStore, ownerId: string, submittedCode: string): Promise<void> {
  const otp = await store.liveCode(ownerId)

  if (!otp) {
    throw new Error('No verification code found. Please request a new one.')
  }
  if (otp.expires_at < new Date()) {
    throw new Error('Your code has expired. Please request a new one.')
  }
  if (otp.attempts >= MAX_ATTEMPTS) {
    throw new Error('Too many incorrect attempts. Please request a new code.')
  }

  const valid = await bcrypt.compare(submittedCode, otp.code_hash)
  if (!valid) {
    const attemptsLeft = MAX_ATTEMPTS - (otp.attempts + 1)
    await store.countAttempt(otp.id)
    throw new Error(
      attemptsLeft > 0
        ? `Incorrect code. ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left.`
        : 'Incorrect code. Too many attempts — please request a new code.'
    )
  }

  await store.consume(otp.id)
  await store.recordActivity(ownerId)
}

// ── Internal users (dbo.app_login_otps → dbo.app_users) ──────────────────────

const internalStore: OtpStore = {
  lastIssued:     (userId) => prisma.otpCode.findFirst({ where: { user_id: userId }, orderBy: { created_at: 'desc' } }),
  liveCode:       (userId) => prisma.otpCode.findFirst({ where: { user_id: userId, consumed_at: null }, orderBy: { created_at: 'desc' } }),
  dropUnconsumed: async (userId) => { await prisma.otpCode.deleteMany({ where: { user_id: userId, consumed_at: null } }) },
  issue:          async (userId, code_hash, expires_at) => { await prisma.otpCode.create({ data: { user_id: userId, code_hash, expires_at } }) },
  countAttempt:   async (id) => { await prisma.otpCode.update({ where: { id }, data: { attempts: { increment: 1 } } }) },
  consume:        async (id) => { await prisma.otpCode.update({ where: { id }, data: { consumed_at: new Date() } }) },
  recordActivity: async (userId) => {
    // A login is activity (Users page "Last activity"). Never fails the login.
    await prisma.user.update({ where: { id: userId }, data: { last_active_at: new Date() } })
      .catch(err => console.error('[otp] last activity not recorded:', err instanceof Error ? err.message : err))
  },
}

/**
 * Generates a fresh login OTP for this user, emails it, and invalidates
 * any previously-issued unconsumed code so only one is ever valid at once.
 * Throws OtpRateLimitError if called again too soon after the last request.
 */
export const requestLoginOtp = (userId: string, email: string, name: string): Promise<void> =>
  issueOtp(internalStore, userId, email, name)

/**
 * Verifies a submitted OTP for this user. Throws a user-facing Error on any
 * failure (no code on file, expired, too many attempts, wrong code) —
 * callers (lib/auth.ts authorize()) should let these propagate so NextAuth
 * surfaces the specific message. On success, marks the code consumed so it
 * can't be replayed.
 */
export const verifyLoginOtp = (userId: string, submittedCode: string): Promise<void> =>
  checkOtp(internalStore, userId, submittedCode)

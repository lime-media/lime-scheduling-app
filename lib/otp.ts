import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { sendOtpEmail } from '@/lib/email'

const CODE_TTL_MINUTES     = 10
const MAX_ATTEMPTS         = 5
const RESEND_COOLDOWN_SECS = 45

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
 * Generates a fresh login OTP for this user, emails it, and invalidates
 * any previously-issued unconsumed code so only one is ever valid at once.
 * Throws OtpRateLimitError if called again too soon after the last request.
 */
export async function requestLoginOtp(userId: string, email: string, name: string): Promise<void> {
  const lastSent = await prisma.otpCode.findFirst({
    where:   { user_id: userId },
    orderBy: { created_at: 'desc' },
  })

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
  await prisma.otpCode.deleteMany({ where: { user_id: userId, consumed_at: null } })

  await prisma.otpCode.create({
    data: {
      user_id:    userId,
      code_hash,
      expires_at: new Date(Date.now() + CODE_TTL_MINUTES * 60_000),
    },
  })

  await sendOtpEmail({ to: email, name, code, ttlMinutes: CODE_TTL_MINUTES })
}

/**
 * Verifies a submitted OTP for this user. Throws a user-facing Error on any
 * failure (no code on file, expired, too many attempts, wrong code) —
 * callers (lib/auth.ts authorize()) should let these propagate so NextAuth
 * surfaces the specific message. On success, marks the code consumed so it
 * can't be replayed.
 */
export async function verifyLoginOtp(userId: string, submittedCode: string): Promise<void> {
  const otp = await prisma.otpCode.findFirst({
    where:   { user_id: userId, consumed_at: null },
    orderBy: { created_at: 'desc' },
  })

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
    await prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } })
    throw new Error(
      attemptsLeft > 0
        ? `Incorrect code. ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left.`
        : 'Incorrect code. Too many attempts — please request a new code.'
    )
  }

  await prisma.otpCode.update({ where: { id: otp.id }, data: { consumed_at: new Date() } })
}

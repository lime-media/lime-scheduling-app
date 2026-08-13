import { NextRequest, NextResponse } from 'next/server'
import { verifyInternalCredentials } from '@/lib/auth'
import { requestLoginOtp, OtpRateLimitError } from '@/lib/otp'

// Step 1 of login — verifies email/password and, if correct, emails a fresh
// OTP. Does NOT create a session; the client follows up with
// signIn('credentials', { email, password, otp }) once the user has the
// code, which is what actually authenticates (see lib/auth.ts).
export async function POST(req: NextRequest) {
  const { email, password } = await req.json()
  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password required' }, { status: 400 })
  }

  const user = await verifyInternalCredentials(email, password)
  if (!user) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
  }

  try {
    await requestLoginOtp(user.id, user.email, user.name)
  } catch (e) {
    if (e instanceof OtpRateLimitError) {
      return NextResponse.json({ error: e.message }, { status: 429 })
    }
    console.error('[auth/request-otp] failed to send OTP:', e)
    return NextResponse.json({ error: 'Failed to send verification code. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

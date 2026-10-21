/**
 * Step 1 of client-portal login: check the password, email a code.
 *
 * Mirrors the internal flow (app/api/auth/request-otp). The password is
 * checked again in step 2 (app/api/client/auth/login), so this route issuing
 * a code is not by itself a way in.
 *
 * A wrong username and a wrong password give the same answer, so this can't
 * be used to find out which accounts exist.
 */

import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { OtpRateLimitError } from '@/lib/otp'
import { maskEmail, NoClientEmailError, requestClientLoginOtp } from '@/lib/clientOtp'

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json()
    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password required' }, { status: 400 })
    }

    const user = await prisma.clientUser.findUnique({ where: { username } })
    const valid = user && await bcrypt.compare(password, user.password_hash)
    if (!user || !valid) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    await requestClientLoginOtp(user.id, user.email, user.company_name)
    return NextResponse.json({ sentTo: maskEmail((user.email ?? '').trim()) })
  } catch (e) {
    if (e instanceof OtpRateLimitError) {
      return NextResponse.json({ error: e.message }, { status: 429 })
    }
    // No address on file: a real dead end for the person, not a server fault.
    if (e instanceof NoClientEmailError) {
      return NextResponse.json({ error: e.message }, { status: 409 })
    }
    console.error('[client/auth/request-otp]', e)
    return NextResponse.json({ error: 'Could not send a code. Please try again.' }, { status: 500 })
  }
}

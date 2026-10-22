/**
 * Step 2 of client-portal login: password AND the emailed code.
 *
 * Step 1 (app/api/client/auth/request-otp) already checked the password once
 * to decide whether to send a code. It is checked again here, because this is
 * the call that actually issues a session — step 1 is not a trusted gate.
 *
 * There is no password-only path: a request without a code is refused before
 * anything else is read.
 */

import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { setClientSession } from '@/lib/clientAuth'
import { verifyClientLoginOtp } from '@/lib/clientOtp'
import { OtpError } from '@/lib/otp'

export async function POST(req: NextRequest) {
  try {
    const { username, password, otp } = await req.json()
    // Typed, not just truthy: anything else reaches Prisma and bcrypt and
    // comes back a 500 when it is really a bad request.
    if (typeof username !== 'string' || typeof password !== 'string' || typeof otp !== 'string'
        || !username || !password || !otp) {
      return NextResponse.json({ error: 'Username, password and code required' }, { status: 400 })
    }

    const user = await prisma.clientUser.findUnique({ where: { username } })
    if (!user) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    // Marks the code consumed and records the login as activity. Only an
    // OtpError is meant for the person typing — a database fault throws
    // something else, and its message (table names, SQL text) must not land
    // on a login screen, so it goes to the outer catch: logged, and a 500.
    try {
      await verifyClientLoginOtp(user.id, otp.trim())
    } catch (err) {
      if (err instanceof OtpError) {
        return NextResponse.json({ error: err.message }, { status: 401 })
      }
      throw err
    }

    const res = NextResponse.json({
      id:          user.id,
      username:    user.username,
      companyName: user.company_name,
    })
    setClientSession(res, {
      id:             user.id,
      username:       user.username,
      companyName:    user.company_name,
      partnerId:      user.partner_id ?? undefined,
      sfdcAccountId:  user.sfdc_account_id ?? undefined,
    })
    return res
  } catch (e) {
    console.error('[client/auth/login]', e)
    return NextResponse.json({ error: 'Login failed' }, { status: 500 })
  }
}
